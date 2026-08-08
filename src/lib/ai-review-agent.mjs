// tuipr — AI-REVIEW-AGENT: az AGENT-VEZÉRELT review végrehajtása.
//
// A TUI INDÍT és MÉR, a findingokat maga az agent írja a hunk sessionbe (a
// hunk-review skill `comment apply` batch-útján). Ami itt lakik: az agent-prompt
// és -argv, a háttér-processz a watchdoggal, az NDJSON stream-olvasó, és a végső
// burkoló parse-olása.
//
// RÉTEGREND: lefelé importál (ai-review-run: a HUMAN-IN-THE-LOOP gate;
// allowlist, ai-review-config, ai-review-view). Az ai-review-run.mjs SEMMIT nem
// kér vissza innen — mérve egyirányú, a scripts/check-next-modules.mjs őrzi.
//
// A GATE UGYANAZ, mint a séma-alapú úton: a claude SIKERE NEM ELÉG. Ha a hunk
// sessionbe egyetlen komment sem került, a review NEM sikeres — különben a TUI
// "0 finding, minden rendben"-t jelentene, ami a hazug üres válasz.
import { aiReviewGate } from './ai-review-run.mjs'
import { hunkCommentCount } from './hunk.mjs'
import {
  AI_REVIEW_ALLOWED_TOOLS_ARGS,
  AI_REVIEW_DISALLOWED_TOOLS_ARGS,
  AI_REVIEW_SETTING_SOURCES_ARGS,
  PERMISSION_REALITY_INSTRUCTION,
  denialMessage,
} from './allowlist.mjs'
import { REVIEW_PATHS, budgetArgs, claudePath, modelArgs } from './ai-review-config.mjs'
import { AI_REVIEW_TIMEOUT_MS } from './ai-review-view.mjs'
import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'

// --- AGENT-VEZÉRELT review: a TUI INDÍT és MÉR, a findingokat az agent írja --
//
// A FELELŐSSÉG-HATÁR a v1-hez (runAiReview + injectHunkComments) képest
// megfordult, és ez a fordulat a lényeg:
//   v1: a claude strukturált findings-JSON-t ADOTT VISSZA, és a TUI írta be őket
//       a hunk sessionbe (injectHunkComments). A TUI-nak ismernie kellett a
//       hunk-CLI-t, ÉS a findings-modellt a mi sémánkra kellett laposítani —
//       a severity/rule_ref/kategória elveszett.
//   v2 (ez): a review-agent MAGA írja a hunkba (a hunk-review skill
//       `comment apply` batch-útján), a TUI CSAK indít és VÁR. Az agent a saját,
//       gazdagabb findings-modelljét használhatja, és a TUI-ból kikerül a
//       hunk-írás.
//
// AMIT EZ A FORDULAT ELVESZ: a burkoló válasza már NEM tartalmazza a
// findingokat, tehát a `parseAiReviewResult` findings-gate-je (a v1
// legfontosabb védelme) itt ELVBŐL nem alkalmazható. A helyére a MÉRÉS lép:
// a hunk komment-darabszáma ELŐTTE és UTÁNA — lásd aiReviewGate. A sorrend
// ezért kötött: MÉR → INDÍT → ÚJRA MÉR → GATE.

/**
 * Az agent-vezérelt review promptja.
 *
 * KÉT TILALOM van benne, és mindkettő egy KONKRÉT kárt zár ki:
 *
 *  1. NE POSZTOLJ GITHUBRA. A findingoknak a hunk sessionbe kell menniük, mert
 *     ott megy végig rajtuk a fejlesztő (`comment rm`), és a MEGLÉVŐ 'f' út
 *     tölti fel a MEGMARADTAKAT a mi attribúciónkkal. Ha az agent maga posztol,
 *     a human-in-the-loop kapu KIMARAD (a body `verifiedBy` állítása hazug lesz),
 *     és a formátum sem a miénk. A hivatalos code-review plugin épp ezt teszi
 *     (`gh pr comment`), tehát a tilalom nem elméleti.
 *  2. NE TÖRÖLD/SZERKESZD a meglévő kommenteket. A sessionben a FEJLESZTŐ saját
 *     megjegyzései is ott lehetnek; azokhoz a review-agentnek nincs dolga. Ez
 *     nem csak etikett: a gate a darabszám NÖVEKMÉNYÉT méri, tehát egy törlés
 *     elmaszkolná az újonnan írt findingokat (5 törölt + 5 új = 0 növekmény →
 *     hamis "nem írt semmit"), vagy fogyásként fail-closed bukást adna.
 */
// A VÁLASZ-JSON instrukció — a DUPLA KÖNYVELÉS (hibrid réteg (a) lába). MINDIG
// benne van a promptban, session-állapottól függetlenül: ha a session a futás
// közben hal meg, a findingok a válaszból még megmenthetők.
const ANSWER_FINDINGS_INSTRUCTION = [
  'A VÉGSŐ válaszodban a findingokat STRUKTURÁLTAN IS add vissza, egy fenced',
  'JSON blokkban, PONTOSAN ebben a sémában:',
  '',
  '```json',
  '{"summary":"2-4 mondat: mit néztél át, mi a fő kockázat, mi a verdict",'
    + '"findings":[{"filePath":"src/a.ts","newLine":5,"summary":"egy mondat","rationale":"opcionális hosszabb indoklás"}]}',
  '```',
  '',
  // AZ ÖSSZEGZŐ (wf24/2): a user a hatodik élő futás után jelentette, hogy "nem
  // találok összegzést sehol" — és igaza volt: a prompt SOSEM kérte, tehát nem
  // volt MIT megjeleníteni. A findingok listája nem helyettesíti a verdictet.
  'A felső szintű `summary` KÖTELEZŐ és EMBER-OLVASHATÓ: 2-4 magyar mondatban',
  'mondd meg, MIT néztél át (fájlok/fókusz), MI a fő kockázat, és MI a verdict.',
  'Ez a TUI paneljében és a GitHub review-body-ban is megjelenik — ne ismételd',
  'benne a findingok listáját, hanem összegezz.',
  '',
  'A `newLine` a post-image, az `oldLine` a pre-image oldal 1-alapú sorszáma —',
  'findingonként PONTOSAN az egyiket add meg. Ha nem találtál semmit, adj vissza',
  'ÜRES findings tömböt (a `summary` akkor is kell). Ez a blokk KÖTELEZŐ: e',
  'nélkül a session megszűnése esetén a findingjaid elvesznek.',
].join('\n')

function agentReviewPrompt({ pr, repoRoot, reviewPath, sessionAlive = true, headRef = null }) {
  const path = REVIEW_PATHS.find((p) => p.id === reviewPath)
  // A SZENTESÍTETT fájl-olvasási út. MÉRT hibaosztály: ref-átadás nélkül az
  // agent a `gh api .../contents | base64 -d`-hez nyúlt — a pipe-ot a
  // permission-minta elvből nem engedheti, tehát denied lett, a review pedig
  // csonka. A lokális git show-hoz a TUI által MÁR lefetchelt ref kell.
  const fileAccessBlock = headRef
    ? [
        '',
        `FÁJL-TARTALOM OLVASÁSA: a PR head-je lokálisan elérhető — \`git show ${headRef}:<path>\`.`,
        'A `gh api …/contents` út TILOS (base64 + pipe kellene hozzá, amit a',
        'permission-réteg nem enged át — a hívásod denied lesz és a review csonkul).',
      ]
    : []
  const hunkBlock = sessionAlive
    ? [
        'A FINDINGOKAT A HUNK SESSIONBE ÍRD, NEM GITHUBRA.',
        'Használd a `hunk-review` skillt (a `hunk session comment apply` batch-útját),',
        `és a \`--repo ${repoRoot}\` sessionbe írj. Minden findinghoz adj meg`,
        'FÁJL-t és SOR-t (a hunk `--new-line` a post-image, `--old-line` a pre-image',
        'oldal 1-alapú sorszáma) — pozíció nélküli findingot NE írj be, mert a',
        'feltöltés fail-closed módon elhasal rajta.',
        '',
        'TILOS a hunk sessionben MÁR MEGLÉVŐ kommentet törölni (`comment rm`) vagy',
        'átírni: azok között a fejlesztő SAJÁT megjegyzései is ott lehetnek. Csak',
        'ÚJAKAT adj hozzá.',
      ]
    : [
        // NINCS élő session: a hunk-írás kérése a semmibe menne (és tokent
        // költene rá). A findingok EGYETLEN csatornája ilyenkor a válasz-JSON.
        'NINCS élő hunk-session erre a repóra: NE hívd a hunk CLI-t, és NE próbálj',
        'sessiont nyitni. A findingokat KIZÁRÓLAG a lenti válasz-JSON-ban add vissza.',
      ]
  return [
    `Futtasd le a \`${path.command}\` review-t a #${pr} pull requestre.`,
    '',
    `A repo gyökere: ${repoRoot}`,
    '',
    ...hunkBlock,
    ...fileAccessBlock,
    '',
    PERMISSION_REALITY_INSTRUCTION,
    '',
    'A feltöltésről a fejlesztő dönt, miután a findingokat átnézte.',
    '',
    ANSWER_FINDINGS_INSTRUCTION,
    '',
    'Valódi defekteket keress: korrektség, hibakezelés, race condition, biztonság,',
    'elnyelt hiba, hiányzó teszt kritikus úton. Stílus-megjegyzést NE adj.',
    'Ha tényleg nem találsz semmit, azt EXPLICITEN jelentsd ki a válaszodban —',
    'a "nem írtam be semmit" némán NEM értelmezhető sikeres review-ként.',
  ].join('\n')
}

/**
 * Az agent-vezérelt review `claude -p` hívásának alakja. Külön, TISZTA
 * függvény, hogy a flagek és a prompt-tilalmak teszt alatt legyenek.
 *
 * MIÉRT NINCS `--json-schema`: ezen az úton a findingok NEM a burkoló válaszán
 * jönnek vissza (azokat az agent a hunkba írja), tehát egy findings-séma
 * kikényszerítése hazug szerződés lenne — a siker mérése az aiReviewGate.
 *
 * A `--tools` viszont BŐVEBB, mint a v1-en: az agentnek ÍRNIA kell (a hunk-CLI-t
 * a Bash-en hívja), és a review-skillek agent-fanoutot indítanak, ezért a Task
 * is kell. Ez a szűkítés így is szándékos: a Write/Edit NINCS benne, tehát az
 * agent a REPÓT nem módosíthatja — csak a hunk sessiont.
 */
export function agentReviewCommand({ pr, repoRoot, reviewPath, maxBudgetUsd, model, sessionAlive = true, headRef = null }) {
  const args = [
    '-p', agentReviewPrompt({ pr, repoRoot, reviewPath, sessionAlive, headRef }),
    // A `stream-json` A PROGRESSZ-JELZÉS ELŐFELTÉTELE, nem stílusválasztás.
    //
    // MÉRT TÉNY (claude 2.1.220): a `--output-format json` EGY nagy JSON-t ad a
    // VÉGÉN — 5.88 s wall alatt a stdout KÖZBEN ÜRES volt. Streamként olvasni
    // tehát nem is volt MIT: a user "5 perc alatt se látok semmi feedbacket"
    // élménye ezen az úton STRUKTURÁLISAN elkerülhetetlen volt.
    //
    // A `stream-json` VISZONT azonnal ad `{"type":"system","subtype":"init"}`-et
    // (még a modell-hívás ELŐTT — tehát az "elindult" azonnal jelezhető), majd
    // per-message `tool_use` blokkokat és `rate_limit_event`-et. A `result` sor
    // UGYANAZ az objektum, mint a régi teljes kimenet, tehát a burkoló-parse
    // változatlan marad.
    //
    // A `--verbose` KÖTELEZŐ a `stream-json` mellett: a claude egyébként
    // megtagadja a hívást ("--output-format=stream-json requires --verbose").
    '--output-format', 'stream-json',
    '--verbose',
    // A plafon OPCIONÁLIS és defaultban NINCS (lásd a budget-fejezet indoklását:
    // a flag API-költésre való, a user viszont subscription-limitet fogyaszt).
    ...budgetArgs(maxBudgetUsd),
    '--permission-mode', 'dontAsk',
    // A `Skill` TOOL NÉLKÜL AZ ÚT JÁRHATATLAN — MÉRVE (#904).
    //
    // A prompt épp azt kéri, hogy az agent futtassa a `/agent-review`-t és
    // használja a `hunk-review` skillt. A régi lista (`Bash,Read,Grep,Glob,Task`)
    // a `Skill` toolt KIHAGYTA: az éles próbán a claude a `"tools"` mezőben
    // `["Task","Bash","Glob","Grep","Read"]`-et jelentett, tehát a skill-hívás
    // ELVBŐL sem volt lehetséges. A #904-es futás naplója ezt megerősítette: az
    // agent sorra permission-megtagadásokba futott, majd kimondta, hogy "a review
    // nem futott le".
    '--tools', 'Bash,Read,Grep,Glob,Task,Skill',
    // A PERMISSION-ALLOWLIST — a `--tools` mellett a MÁSODIK kapu, és a #904-es
    // futás VALÓDI blokkolója. Indoklás és mérés: `AI_REVIEW_ALLOWED_TOOLS`.
    ...AI_REVIEW_ALLOWED_TOOLS_ARGS,
    // Az explicit deny (mutáló gh-utak) — deny > allow, egy jövőbeli
    // allow-lazítás ellen is tart.
    ...AI_REVIEW_DISALLOWED_TOOLS_ARGS,
    // IZOLÁCIÓ: a user-szintű CLAUDE.md kizárva, a projekt-skillek maradnak
    // (mérés: AI_REVIEW_SETTING_SOURCES feje).
    ...AI_REVIEW_SETTING_SOURCES_ARGS,
    // A MODELL MINDIG EXPLICIT — default: opus (lásd AI_REVIEW_DEFAULT_MODEL).
    ...modelArgs(model),
  ]
  return ['claude', args]
}

/**
 * Az agent-vezérelt review lefuttatása: MÉR → INDÍT → ÚJRA MÉR → GATE.
 *
 * A LÉPÉSEK SORRENDJE A SZERZŐDÉS:
 *  1. a review-út VALIDÁLÁSA — a claude-hívás ELŐTT, mert egy kizárt út
 *     (`/review` egy-agentes one-shot, `/code-review ultra` cloud-ban fut és a
 *     binary tiltja az agent-indítást) elindítva vagy pénzt éget, vagy némán
 *     rosszabb review-t ad;
 *  2. a `before` MÉRÉS — a claude ELŐTT, mert enélkül a növekmény nem
 *     számolható (a sessionben már lehetnek a fejlesztő saját kommentjei);
 *  3. a `claude -p` indítása;
 *  4. a burkoló fail-closed olvasása (exit-kód, is_error, api_error_status,
 *     subtype, permission_denials) — ez SZŰKSÉGES, de NEM ELÉGSÉGES;
 *  5. az `after` MÉRÉS és az aiReviewGate — EZ a valódi gate.
 *
 * A 4. és 5. viszonya a lényeg: a `claude -p` MÉRVE adhat exit 0 +
 * `subtype:"success"` + `is_error:false` választ úgy, hogy a review le sem
 * futott. Ezen az úton a burkoló válasza a findingokról SEMMIT nem bizonyít
 * (azokat az agent a hunkba írja), tehát az EGYETLEN megfigyelhető tény a
 * darabszám növekménye. A 4. lépés azért marad, mert a konkrét burkoló-hiba
 * (permission-megtagadás, API-hiba) MAGYARÁZÓBB üzenetet ad, mint a végén
 * bukó gate "nem írt semmit"-je.
 */
// A `maxBudgetUsd` SZÁNDÉKOSAN nincs defaultolva: a default-OFF szerződés
// szerint a plafon hiánya a normál eset, egy beégetett `= 3` pedig némán
// visszahozná a flaget minden hívóra, aki nem ad át semmit.
export function runAgentReview({ pr, repoRoot, reviewPath, maxBudgetUsd, model, cwd }) {
  // 1. A review-út validálása — a claude-hívás ELŐTT (nincs félig-költés).
  const path = REVIEW_PATHS.find((p) => p.id === reviewPath)
  if (!path) {
    const known = REVIEW_PATHS.map((p) => p.id).join(', ')
    throw new Error(
      `érvénytelen review-út: ${JSON.stringify(reviewPath)} — a claude-hívás EL SEM INDULT. `
      + `Választható utak: ${known}. `
      + 'A builtin `/review` (egy-agentes one-shot) és a `/code-review ultra` '
      + '(cloud-ban fut, $5-25/run, és a binary tiltja az agent-indítást) SZÁNDÉKOSAN kizárt.',
    )
  }

  const cp = claudePath()
  if (!cp) {
    throw new Error(
      'a `claude` CLI nem érhető el a PATH-on, ezért az AI-review nem futtatható. '
      + 'Telepítsd a Claude Code CLI-t (vagy tedd a PATH-ra), majd próbáld újra. '
      + 'Addig a hunk-diffes review (`d`) mindig működik.',
    )
  }

  // 2. A `before` MÉRÉS. Ha a hunk-session nem olvasható, itt HANGOSAN bukunk —
  // a claude EL SEM INDUL. Ok: mérhető kezdőállapot nélkül a gate nem
  // értelmezhető, és a token-költés után bukni rosszabb, mint előtte.
  //
  // A `context: 'review'` a HIBASZÖVEGET választja: ezen az úton a "nincs élő
  // session" ELŐFELTÉTEL-hiba (a findingok oda kerülnének), tehát az üzenet a
  // megnyitás útját adja — nem a nyers hunk-stderrt, ami a #904-es
  // user-jelentésben használhatatlan volt.
  const before = hunkCommentCount(repoRoot, { context: 'review' })

  // 3. A hívás.
  const [cmd, args] = agentReviewCommand({ pr, repoRoot, reviewPath, maxBudgetUsd, model })
  const res = spawnSync(cmd, args, { encoding: 'utf8', cwd, maxBuffer: 64 * 1024 * 1024 })
  if (res.error) throw new Error(`a claude -p nem indult el: ${res.error.message}`)

  // 4. A burkoló fail-closed olvasása — SZŰKSÉGES, de NEM ELÉGSÉGES.
  const envelope = parseAgentReviewEnvelope(res.stdout, res.status, res.stderr)

  // 5. Az `after` MÉRÉS és A VALÓDI GATE. Az aiReviewGate dobása MAGYARÁZÓ:
  // ott derül ki, hogy a "sikeres" claude semmit nem írt, vagy törölt.
  //
  // A KONTEXTUS ITT MÁS (`after`): a claude MÁR LEFUTOTT, tehát a review-ág
  // "tokent NEM költöttünk" mondata itt HAZUG lenne. Ez a hibaosztály sem
  // elméleti: az agent (vagy a hunk daemonja) a futás közben elzárhatja a
  // sessiont, és akkor a `before` sikere után az `after` bukik el.
  const after = hunkCommentCount(repoRoot, { context: 'after' })
  const gate = aiReviewGate({ before, after })

  return {
    ...gate,
    reviewPath: path.id,
    model: envelope.model,
    costUsd: envelope.costUsd,
    sessionId: envelope.sessionId,
    durationMs: envelope.durationMs,
    result: envelope.result,
  }
}



/**
 * Az NDJSON `stream-json` folyam EGY SORÁNAK olvasása → progressz-jelzés.
 *
 * MÉRT SÉMA (claude 2.1.220, `--output-format stream-json --verbose`, éles próba):
 *   {"type":"system","subtype":"init","cwd":"…","model":"claude-haiku-4-5",…}
 *   {"type":"system","subtype":"status","status":"requesting",…}
 *   {"type":"stream_event","event":{…},"ttft_ms":1152}
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash",…}]}}
 *   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning",…}}
 *   {"type":"result","subtype":"success","num_turns":2,…}
 *
 * A `result` sor UGYANAZ a JSON objektum, mint a `--output-format json` teljes
 * kimenete — ezért a `parseAgentReviewEnvelope` VÁLTOZATLANUL használható, csak
 * az utolsó `result` sort kell neki átadni.
 *
 * A RATE-LIMIT ESEMÉNY SEM NÉMA: az éles próbán `utilization: 0.78` jött a
 * 7-napos limitre. Ezt a régi kód EGYÁLTALÁN nem látta (a végső envelope-ban
 * nincs benne), és ez a "megszakítva" egyik komoly gyanúsítottja volt.
 *
 * `null`-t ad, ha a sor nem jelzés-értékű (nem parse-olható, vagy nem érdekes) —
 * a hívó ilyenkor nem ír semmit. A NÉMA ELNYELÉS itt LEGITIM és szűk: egy
 * csonka NDJSON-sor (a chunk-határon félbevágott JSON) NORMÁLIS, nem hiba.
 */
export function parseStreamProgressLine(line) {
  const text = String(line ?? '').trim()
  if (text === '') return null
  let ev
  try {
    ev = JSON.parse(text)
  } catch {
    return null
  }
  if (ev?.type === 'system' && ev?.subtype === 'init') return { event: 'init', tool: 'elindult' }
  if (ev?.type === 'rate_limit_event') {
    const info = ev.rate_limit_info ?? {}
    const pct = Number(info.utilization)
    return {
      event: 'rate-limit',
      tool: Number.isFinite(pct)
        ? `RATE-LIMIT: ${Math.round(pct * 100)}% (${info.rateLimitType ?? '?'})`
        : `RATE-LIMIT: ${info.status ?? '?'}`,
    }
  }
  if (ev?.type === 'assistant') {
    const blocks = ev.message?.content
    if (Array.isArray(blocks)) {
      const use = blocks.find((b) => b?.type === 'tool_use')
      if (use) return { event: 'tool', tool: String(use.name ?? 'tool') }
    }
  }
  // A `result` sor a VÉGSŐ envelope — NEM progressz, a hívó a burkoló-parse-nak
  // adja át. A jelzés viszont hasznos: innen tudjuk, hogy a stream lezárult.
  if (ev?.type === 'result') return { event: 'result', envelopeLine: text }
  return null
}

/**
 * A HÁTTÉR-REVIEW: a `claude -p` ASZINKRON indítása, a MÁR ÉLŐ hunk-sessionbe.
 *
 * EZ A PÁRHUZAMOS MODELL. A user kérése: "nem tudunk olyat, hogy első r-re
 * megnyit [a PR] diff-et és háttérprocesszből indít rá review-t?"
 *
 * MÉRT ELŐFELTÉTEL (hunk 0.17.0, élő TUI mellett, MÁSIK processzből): a
 * hunk-session a TUI futása KÖZBEN is olvasható ÉS írható — a daemon a broker.
 * Mindhárom hívás lefutott egy külön processzből, miközben a hunk TUI futott:
 *   hunk session reload  --repo <path> -- diff        → "Reloaded repo …"
 *   hunk session comment apply --repo <path> --stdin  → "Applied 1 live comments"
 *   hunk session comment list  --repo <path> --type agent --json → 1 komment
 * ÉS a beírt komment a FUTÓ TUI-ban MEG IS JELENIK ("Agent note", az `a` =
 * toggle AI notes nézetben) — tehát a user tényleg LÁTJA, ahogy megszületnek.
 *
 * MIÉRT `spawn` ÉS NEM `spawnSync` (ugyanaz az érv, mint a merge-tree mérőnél):
 * a spawnSync a review teljes idejére MEGFAGYASZTJA az Ink render-loopját — se
 * navigálni, se kilépni nem lehetne, és a "háttérben fut" ígéret hazugság lenne.
 *
 * A SORREND-GARANCIA A HÍVÓ FELELŐSSÉGE (waitForHunkSession): ez a függvény
 * FELTÉTELEZI, hogy a session MÁR él. Enélkül a claude a semmibe írna, és a
 * token elmenne — épp ezért van a várakozás KÜLÖN, mérhető lépésként.
 *
 * A `spawn` INJEKTÁLHATÓ: a stream-kezelés, a kill és az ENOENT-ág így valódi
 * gyerekfolyamat (és valódi token-költés) nélkül tesztelhető.
 *
 * VISSZATÉR: `{ abort, done }` — a `done` egy Promise, ami a burkoló-metaadattal
 * (vagy hibával) settle-el. Az `abort` a KILÉPÉSI ÚT: a TUI-ból kilépő user
 * (`q`) nem hagyhat hátra zombie claude-ot.
 *
 * --- A #904-ES JAVÍTÁSOK, MIND A HÁROM -------------------------------------
 *
 * 1. AZ ABORT OKA MOSTANTÓL ÁTMEGY (`abort(reason)`), nem csak egy `aborted`
 *    boolean. A régi kódban a `q` (kilépés), az `x` (user-megszakítás) és a
 *    timeout MIND ugyanazt az `{ aborted: true }`-t adta, a hívó pedig
 *    "megszakítva"-t írt — ez a user által jelentett HAZUG jelzés.
 *
 * 2. A PROGRESSZ-CALLBACK (`onProgress`) a `stream-json` NDJSON-sorait kapja
 *    SORONKÉNT. Enélkül a status-sor a statikus indulási szövegen áll — ez volt
 *    a "5 perc alatt se látok semmi feedbacket".
 *
 * 3. A WATCHDOG (`timeoutMs`) SAJÁT végállapotot ad. A `claude` CLI-nek MÉRVE
 *    nincs `--timeout` flagje, tehát a plafon a mi felelősségünk; enélkül a
 *    review ÓRÁKIG loghatott.
 */
export function startAgentReview({
  pr, repoRoot, reviewPath, maxBudgetUsd, model, cwd,
  // A HIBRID réteg session-állapota: false esetén a prompt a hunk-írás helyett
  // a válasz-JSON-t kéri KIZÁRÓLAGOS csatornaként (lásd agentReviewPrompt).
  sessionAlive = true,
  spawn: spawnImpl = spawn,
  onProgress,
  timeoutMs = AI_REVIEW_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout, headRef = null }) {
  // A review-út VALIDÁLÁSA a spawn ELŐTT (nincs félig-költés) — ugyanaz a
  // szerződés, mint a szinkron úton.
  const path = REVIEW_PATHS.find((p) => p.id === reviewPath)
  if (!path) {
    const known = REVIEW_PATHS.map((p) => p.id).join(', ')
    throw new Error(
      `érvénytelen review-út: ${JSON.stringify(reviewPath)} — a claude-hívás EL SEM INDULT. `
      + `Választható utak: ${known}.`,
    )
  }
  const cp = claudePath()
  if (!cp) {
    throw new Error(
      'a `claude` CLI nem érhető el a PATH-on, ezért az AI-review nem futtatható. '
      + 'Telepítsd a Claude Code CLI-t (vagy tedd a PATH-ra), majd próbáld újra. '
      + 'Addig a hunk-diffes review (`d`) mindig működik.',
    )
  }

  const [cmd, args] = agentReviewCommand({ pr, repoRoot, reviewPath, maxBudgetUsd, model, sessionAlive, headRef })
  const child = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd })
  let stdout = ''
  let stderr = ''
  // AZ ABORT OKA, NEM CSAK A TÉNYE. A régi `aborted` boolean összemosta a
  // kilépést, a user-megszakítást és a timeoutot — pontosan az a gyűjtőág,
  // amiből a #904-es hazug "megszakítva" jött.
  let abortReason = null
  let settled = false
  let resolveDone
  let rejectDone
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej })
  // A `done` promise-t MINDIG kezelik (a hívó await-eli), de egy abortált
  // review-nál a hívó már nem érdeklődik — a `catch`-elés nélkül az
  // unhandledRejection dőlne el a processzen.
  const settle = (fn) => {
    if (settled) return
    settled = true
    fn()
  }

  // A WATCHDOG. MIÉRT SAJÁT (és nem CLI-flag): a `claude --help` (2.1.220) MÉRVE
  // nem ismer se `--timeout`-ot, se `--max-turns`-t. Enélkül a review ÓRÁKIG
  // loghat némán — a #904-es user esetében pontosan ez a félelme volt reális.
  let watchdog = null
  const clearWatchdog = () => {
    if (watchdog !== null) { clearTimer(watchdog); watchdog = null }
  }
  if (Number(timeoutMs) > 0) {
    watchdog = setTimer(() => {
      // A TIMEOUT IS ABORT — de SAJÁT okkal, tehát a hívó SAJÁT üzenetet ad rá.
      abortReason = 'timeout'
      try { child.kill?.() } catch { /* a már kilépett gyerek killje nem hiba */ }
      // A `close` esemény FEL IS SZABADÍTHATNA, de egy már halott (vagy sosem
      // induló) gyerek `close`-a elmaradhat — a settle tehát ITT is megtörténik.
      // A `settle` idempotens, tehát a kettő nem ütközik.
      settle(() => resolveDone({ aborted: true, reason: 'timeout', timeoutMs }))
    }, Number(timeoutMs))
  }

  // A STREAM SORONKÉNTI OLVASÁSA — EZ A PROGRESSZ-JELZÉS MOTORJA.
  //
  // A PUFFER KÖTELEZŐ: a chunk-határ a JSON-sor KÖZEPÉRE eshet (mérve: a stream
  // sorai több száz bájtosak, a pipe chunkja 64 KB-os, de a modell-válaszok
  // darabokban jönnek). Sor-puffer nélkül minden félbevágott sor `null`-t adna,
  // és a jelzés véletlenszerűen kimaradna.
  let lineBuf = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (c) => {
    stdout += c
    if (!onProgress) return
    lineBuf += c
    const parts = lineBuf.split('\n')
    // AZ UTOLSÓ ELEM A CSONKA MARADÉK: az visszakerül a pufferbe.
    lineBuf = parts.pop() ?? ''
    for (const line of parts) {
      const ev = parseStreamProgressLine(line)
      // A CALLBACK HIBÁJA NEM VISZI MAGÁVAL A REVIEW-T: a progressz-jelzés
      // KÉNYELEM, a review a MUNKA. Egy dobó `onProgress` (pl. egy leszerelt
      // React-komponens setState-je) itt unhandled kivételként vinné az egész
      // processzt — a TUI-t is.
      if (ev) { try { onProgress(ev) } catch { /* a jelzés hibája nem review-hiba */ } }
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (c) => { stderr += c })

  child.on('error', (error) => {
    clearWatchdog()
    settle(() => rejectDone(new Error(
      error?.code === 'ENOENT'
        ? 'a claude -p nem indítható (ENOENT): a `claude` nincs telepítve, vagy nincs a PATH-on. '
          + 'Ez NEM review-hiba — a bináris maga hiányzik.'
        : `a claude -p nem indult el: ${error?.message ?? String(error)}`,
    )))
  })
  // A `signal` A MÁSODIK ARGUMENTUM, ÉS NEM ELDOBHATÓ.
  //
  // MÉRT TÉNY: ha a processzt KÍVÜLRŐL ölik meg (OOM-killer, `pkill`, a gép
  // elalvása, a shell SIGHUP-ja), a `close` `code === null`-t ad — a kilépés
  // SZIGNÁLLAL történt. A SZIGNÁL NEVE viszont a MÁSODIK argumentumban van, és a
  // régi kód azt EL SEM OLVASTA. Következmény: a végállapot ELVBŐL nem tudhatta
  // megnevezni az okot, tehát a legjobb esetben is csak annyit mondhatott, hogy
  // "egy szignál ölte meg" — miközben a `SIGKILL` (OOM / `kill -9`), a `SIGTERM`
  // (rendezett leállítás) és a `SIGHUP` (a terminál bezárása) HÁROM MÁS teendőt
  // ír elő a usernek.
  child.on('close', (code, signal) => {
    clearWatchdog()
    // ABORT UTÁN NEM ÁLLÍTUNK SEMMIT: a megszakított review kimenete nem tény
    // (ugyanaz az elv, mint a merge-tree mérő abort-ágán, ami BLOCKER volt).
    // AZ OKOT VISZONT ÁTADJUK: a hívó ebből tudja, MELYIK végállapotot mondja.
    if (abortReason !== null) {
      settle(() => resolveDone({ aborted: true, reason: abortReason, timeoutMs }))
      return
    }
    // A PARSE A `settle` ELŐTT — EZ VOLT A #904-ES GYÖKÉRBUG.
    //
    // A régi kód így szólt:
    //     try { settle(() => resolveDone({ envelope: parse(...) })) }
    //     catch (error) { settle(() => rejectDone(error)) }
    // A `parse` a settle-nek átadott arrow BELSEJÉBEN futott, a `settle` viszont
    // ELŐBB állította `settled = true`-ra, és CSAK AZUTÁN hívta a függvényt. Egy
    // dobó parse tehát: (1) a settle már "elhasználta" magát, (2) a throw kifutott
    // a catch-be, (3) ahol a `settle(() => rejectDone(error))` MÁR NO-OP volt.
    // Se `resolveDone`, se `rejectDone` nem hívódott meg → a `done` promise
    // ÖRÖKRE PENDING maradt → a hívó `await handle.done`-ja beragadt → a
    // `showError` SOSEM futott le → a status-sor örökre az indulási szövegen
    // állt. EZ a user "5 perc alatt se látok semmi feedbacket sehol" élménye.
    //
    // IZOLÁLTAN BIZONYÍTVA: a hibás alakon `Warning: Detected unsettled
    // top-level await` jött, és a `.then(onOk, onErr)` EGYIK callbackje sem
    // sült el, MIKÖZBEN a reject-ág "lefutott".
    //
    // A JAVÍTÁS: a parse a `try` TÖRZSÉBEN, a `settle` HÍVÁSA ELŐTT fut le.
    // Minden burkoló-szintű hiba (permission_denials, is_error,
    // api_error_status, subtype, nem-nulla exit, nem-JSON stdout) így RENDESEN
    // rejectel.
    let envelope
    try {
      envelope = parseAgentReviewEnvelope(stdout, code, stderr)
    } catch (error) {
      // A NYERS TÉNYEK IS ÁTMENNEK: a `failed` végállapot exit-kódot és a stderr
      // ELSŐ SORÁT mutatja, azok viszont a hibaobjektumból nem kinyerhetők.
      // A `signal` IS ÁTMEGY: a `failed` végállapot ebből NEVEZI MEG a szignált.
      settle(() => rejectDone(Object.assign(error, {
        exitCode: code, signal: signal ?? null, stderrText: stderr,
      })))
      return
    }
    settle(() => resolveDone({ envelope, reviewPath: path.id }))
  })

  return {
    done,
    /**
     * A HÁTTÉR-REVIEW MEGSZAKÍTÁSA — KILL, nem detach.
     *
     * MIÉRT KILL (és miért nem hagyjuk futni): a `claude -p` a hunk sessionbe ÍR.
     * Egy detachelt review a TUI kilépése UTÁN is írna egy sessionbe, amit már
     * senki nem néz át — a findingok a következő TUI-indításnál egy MÁS PR
     * kontextusában bukkannának fel, és a `f` feltöltés a MI attribúciónkkal
     * küldené fel őket. Ez pontosan a hazug provenance, amit a feature máshol
     * mindenhol kerül. A zombie pedig külön tilos: a projekt ezt már egyszer
     * megfizette a merge-tree mérőnél.
     *
     * A `reason` A JAVÍTÁS LÉNYEGE: a hívó ebből tudja, hogy a user szakította-e
     * meg (`user`), a TUI bezárása ölte-e meg (`exit`), vagy a watchdog
     * (`timeout`). A régi, ok nélküli abort MINDHÁRMAT "megszakítva"-nak mondta.
     */
    abort: (reason = 'user') => {
      abortReason = reason
      clearWatchdog()
      try { child.kill?.() } catch { /* a már kilépett gyerek killje nem hiba */ }
      // A SETTLE ITT, AZONNAL — NEM a `close` eseményre várva.
      //
      // MÉRT BUG (izoláltan reprodukálva): `spawn(stub)` → `kill()` 300 ms-nál →
      // a `close` esemény 4297 ms-nál. A `kill` a KÖZVETLEN gyereket (`/bin/sh`,
      // élesben a `claude` burkoló) öli meg, az UNOKÁK viszont tovább élnek és
      // FOGJÁK a stdout-pipe-ot; a Node `close`-a pedig a stdio EOF-ját is
      // megvárja. Élesben ez rosszabb: a `claude -p` agent-fanoutot indít (a
      // prompt Task-toolt kér), tehát az unokák akár sokáig futhatnak.
      //
      // A HATÁS A USERRE, ha a `close`-ra várnánk: az `x` (megszakítás) után a
      // status-sor SEMMIT nem mond, amíg a claude-fa magától be nem fejezi a
      // munkát — pontosan a "megnyomtam, és nem történik semmi" élmény, amit ez
      // a csomag javít. A `kill` továbbra is kimegy (nincs zombie), a UI viszont
      // nem az unokákra vár.
      //
      // A `settle` IDEMPOTENS, tehát a később mégis befutó `close` (ami itt az
      // `abortReason`-ág) NEM ír felül semmit.
      settle(() => resolveDone({ aborted: true, reason, timeoutMs }))
    },
  }
}

/**
 * Az agent-vezérelt út burkoló-parse-olása: a `parseAiReviewResult` findings-
 * gate-je NÉLKÜL (itt a findingok nem a válaszon jönnek), de MINDEN
 * burkoló-szintű hibajelzővel.
 *
 * A metaadat MÉRT, nem deklarált: a modell a `modelUsage` kulcsából (ez a
 * TÉNYLEGESEN használt modell — egy elavult env-érték hazug attribúciót adna a
 * PR-on), a költés a `total_cost_usd`-ből.
 */
export function parseAgentReviewEnvelope(stdout, status, stderr = '') {
  const raw = String(stdout ?? '')
  const clip = (s) => (s.length > 2000 ? `${s.slice(0, 2000)}…[csonkolva]` : s)

  if (status !== 0) {
    throw new Error(
      `a claude -p nem-nulla kóddal állt le (exit ${status}).\n`
      + `stderr: ${String(stderr ?? '').trim() || '(üres)'}\n`
      + `stdout: ${clip(raw.trim()) || '(üres)'}`,
    )
  }

  // NDJSON-TOLERÁNS PARSE. A `--output-format stream-json` SOK sort ad, és a
  // VÉGSŐ `{"type":"result",…}` sor UGYANAZ az objektum, mint a régi
  // `--output-format json` teljes kimenete (MÉRT: az éles próbán bit-azonos
  // szerkezet). Ezért nem cseréljük le a parse-olót: az UTOLSÓ `result` sort
  // adjuk neki.
  //
  // A VISSZAFELÉ KOMPATIBILITÁS SZÁNDÉKOS: egyetlen, `\n` nélküli JSON-objektum
  // (a szinkron `runAgentReview` útjának stubjai, és bármely régi hívó) ugyanígy
  // átmegy — az az eset a "egy sor, ami result-típusú" speciális alakja.
  let env
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  // AZ UTOLSÓ `result` SOR, HÁTULRÓL keresve: a stream közben `stream_event` és
  // `assistant` sorok is jönnek, azok NEM burkolók.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let cand
    try {
      cand = JSON.parse(lines[i])
    } catch {
      continue
    }
    // A `type` MEZŐ NÉLKÜLI objektumot is elfogadjuk: a régi (nem-stream)
    // szerződés nem követelte meg a `type: "result"`-ot, és egy hirtelen
    // szigorítás a meglévő hívókat NÉMÁN döntené el.
    if (cand?.type === undefined || cand?.type === 'result') { env = cand; break }
  }
  if (env === undefined) {
    throw new Error(
      'a claude -p kimenetében NINCS `result` burkoló-sor — a review nem verifikálható.\n'
      + `nyers kimenet:\n${clip(raw)}`,
    )
  }

  // Négy FÜGGETLEN hibajelző: egyikük sem implikálja a másikat, és egy
  // modell-szintű kudarc exit 0-t is adhat.
  if (env.is_error === true) {
    throw new Error(`a claude -p hibát jelzett (is_error): ${clip(String(env.result ?? '(nincs result)'))}`)
  }
  if (env.api_error_status !== null && env.api_error_status !== undefined) {
    throw new Error(`a claude -p API-hibát jelzett: api_error_status=${env.api_error_status}`)
  }
  if (env.subtype !== undefined && env.subtype !== 'success') {
    throw new Error(`a claude -p nem sikeres subtype-pal állt le: subtype=${env.subtype}`)
  }
  // A DENIAL NEM FATÁLIS ÖNMAGÁBAN — ADAT. A user harmadik elhasalt futása
  // mutatta meg: 3 denied hívás miatt a TELJES review "ELHASALT"-nak minősült,
  // pedig az agent findingokat is produkált. Részleges review != nulla review:
  // a hívó dönt — findingokkal degradált eredmény (caveat), finding nélkül a
  // régi hangos hiba (a denialMessage szövegével).
  const deniedCommands = Array.isArray(env.permission_denials)
    ? env.permission_denials.map((d) => String(d?.tool_input?.command ?? d?.tool_name ?? '(ismeretlen)'))
    : []

  return {
    deniedCommands,
    denials: Array.isArray(env.permission_denials) ? env.permission_denials : [],
    model: Object.keys(env.modelUsage ?? {})[0] ?? null,
    costUsd: env.total_cost_usd ?? null,
    sessionId: env.session_id ?? null,
    durationMs: env.duration_ms ?? null,
    result: typeof env.result === 'string' ? env.result : null,
  }
}
