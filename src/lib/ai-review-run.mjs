// tuipr — AI-REVIEW-RUN: az AI-review VÉGREHAJTÁSA.
//
// Ami itt lakik: a promptok, a claude argv, a burkoló-parse (FAIL-CLOSED: az
// exit 0 + `is_error: true` is DOBÁS), a HUMAN-IN-THE-LOOP GATE (a claude siker
// NEM elég — a findingoknak a hunk sessionbe KELL kerülnie), a háttér-processz
// és a HÉT végállapot előállítása.
//
// RÉTEGREND: lefelé importál (allowlist: az engedély-politika és a
// permission-realitás blokk; ai-review-config: a scope/claude-út/argv-részletek;
// ai-review-view: az AI_REVIEW_TIMEOUT_MS watchdog-plafon). A view SEMMIT nem
// kér vissza innen — az irány egyirányú (mérve).
//
// A GATE INDOKLÁSA: a claude tökéletes burkolót adhat (exit 0, subtype
// "success", is_error false) ÜRES hunk-session mellett is. Enélkül a TUI "0
// finding, minden rendben"-t jelentene — a hazug üres válasz, amit a szerződés
// tilt.
import {
  AI_REVIEW_ALLOWED_TOOLS_ARGS,
  AI_REVIEW_DISALLOWED_TOOLS_ARGS,
  AI_REVIEW_SETTING_SOURCES_ARGS,
  PERMISSION_REALITY_INSTRUCTION,
  denialMessage,
} from './allowlist.mjs'
import { REVIEW_PATHS, aiReviewScope, budgetArgs, claudePath, modelArgs } from './ai-review-config.mjs'
import { AI_REVIEW_TIMEOUT_MS } from './ai-review-view.mjs'
import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
/**
 * A VALÓDI gate az agent-vezérelt flow-ban: bekerült-e TÉNYLEGESEN komment a
 * hunk sessionbe.
 *
 * MIÉRT NEM ELÉG A CLAUDE EXIT-KÓDJA (mért csapda): a `claude -p` adhat
 * exit 0 + `subtype:"success"` + `is_error:false` választ úgy, hogy a review NEM
 * futott le. Ebben a flow-ban a findingokat MAGA az agent írja a hunkba, tehát
 * a burkoló sikeressége semmit nem bizonyít a findingokról — az EGYETLEN
 * megfigyelhető tény a `comment list` darabszáma ELŐTTE és UTÁNA. Enélkül a TUI
 * "0 finding, minden rendben"-t jelentene: pontosan az a hazug üres válasz,
 * amit a fail-closed szerződés tilt.
 *
 * A FOGYÁS is hiba: a review-agentnek nincs dolga a MEGLÉVŐ (akár a fejlesztő
 * saját) kommentekkel, tehát egy csökkenő darabszám azt jelenti, hogy törölt
 * valamit — az a session korrupciója, nem sikeres review.
 *
 * A "0 finding" LEGITIM eredménye NEM ezen az úton jön: azt az agentnek
 * EXPLICITEN kell jelentenie (lásd aiReviewPrompt), és a hívó dönti el, hogy
 * hívja-e egyáltalán a gate-et.
 */
export function aiReviewGate({ before, after }) {
  if (!Number.isInteger(before) || !Number.isInteger(after)) {
    // A hiányzó MÉRÉSBŐL nem következtetünk sikerre (ugyanaz a fail-closed elv,
    // mint a confirmAccepts armedAt-jánál).
    throw new Error(
      'az AI-review nem verifikálható: a hunk komment-darabszáma nem MÉRT '
      + `(before=${JSON.stringify(before)}, after=${JSON.stringify(after)}). NEM töltünk fel semmit.`,
    )
  }
  if (after < before) {
    throw new Error(
      `az AI-review a hunk sessionből TÖRÖLT kommentet (${before} → ${after}, ${before - after} `
      + 'fogyott). A review-agentnek nincs dolga a meglévő megjegyzésekkel — ez a session '
      + 'korrupciója, nem sikeres review. NEM töltünk fel semmit.',
    )
  }
  if (after === before) {
    throw new Error(
      'a claude -p sikeresen lefutott, de EGYETLEN kommentet sem írt a hunk sessionbe '
      + `(${before} → ${after}). A sikeres burkoló ezt NEM zárja ki (mért csapda: exit 0 + `
      + 'subtype:"success" a le sem futott review-ra is jöhet), tehát a review NEM tekinthető '
      + 'lefutottnak. Ha az agent tényleg nem talált findingot, azt EXPLICITEN kell jelentenie.',
    )
  }
  return { added: after - before, before, after }
}

/**
 * A GATE A PÁRHUZAMOS MODELLHEZ: `noteId`-HALMAZOK diffje, nem darabszám.
 *
 * MIÉRT NEM ELÉG A DARABSZÁM (a `aiReviewGate` fenti alakja) A HÁTTÉR-REVIEW-N:
 * ott a claude futása KÖZBEN a USER IS ír a sessionbe (ő a diffben ül). A puszta
 * növekmény tehát HAMIS pozitívot adhat — két user-komment mellett a gate
 * "sikeres AI-review"-t állítana akkor is, ha a claude egy sort sem írt. És
 * HAMIS NEGATÍVOT is: ha az agent 2-t írt, a user pedig közben 2-t törölt, a
 * darabszám nem változik, holott a review LEFUTOTT.
 *
 * A HALMAZ-DIFF MINDKETTŐT kizárja: az `added` pontosan azok az agent-findingok,
 * amik a claude futása ALATT jelentek meg (`after \ before`).
 *
 * A FAIL-CLOSED ÁGAK MEGMARADNAK, ugyanazzal az indoklással, mint a darabszámos
 * változatban — csak most ID-alapon, tehát pontosabban:
 *   - nem-halmaz bemenet → a mérés nem történt meg, nem következtetünk sikerre;
 *   - ELTŰNT ID (a `before`-ból hiányzik az `after`-ben) → a session korrupciója
 *     (az agentnek TILOS törölnie), tehát NEM sikeres review;
 *   - ÜRES `added` → a "sikeres burkoló, de nem írt semmit" mért csapda.
 */
/**
 * A USER által, a hunk TUI-ban KÉZZEL írt megjegyzés ID-je?
 *
 * MÉRT (hunk 0.17.0, élő TUI-ban, tmux-ból vezérelve):
 *   TUI-ban `c`-vel írt  → `{ noteId: "user:1785433028013", source: "user" }`
 *   CLI-vel apply-olt    → `{ noteId: "mcp:1898b8aa-…:0",   source: "agent" }`
 *
 * A PREFIXRE épül, nem a `source`-ra, mert a gate ID-HALMAZOKKAL dolgozik (a
 * darabszám a párhuzamos modellben hamis pozitívot ad) — a halmazban pedig csak
 * az ID van meg.
 */
function isUserNoteId(id) {
  return typeof id === 'string' && id.startsWith('user:')
}

/**
 * AZ AGENT-ÍRTA ÚJ FINDINGOK ID-JEI — a halmaz-diff EGYETLEN forrása.
 *
 * MIÉRT KÜLÖN, EXPORTÁLT FÜGGVÉNY (mért rés, nem elméleti): a `doAiReview`-ban a
 * `no-findings` végállapot ELDÖNTÉSÉHEZ is kell ugyanez a halmaz-diff, a
 * `aiReviewGateByIds` DOBÁSA ELŐTT. Az első változat ott egy NYERS diffet
 * számolt (`[...after].filter((id) => !before.has(id))`), a `user:` prefix
 * szűrése NÉLKÜL — és a KETTŐ SZÉTCSÚSZÁSA valódi hamis pozitívot adott:
 *
 *   a párhuzamos modellben a USER is ír a sessionbe (ő a diffben ül). Ha az agent
 *   SEMMIT nem írt, de a user írt EGY saját jegyzetet, a szűrés nélküli diff 1
 *   elemet adott → a `no-findings` ág KIMARADT, a futás a gate dobására futott,
 *   és a user egy HIBA-OVERLAYT kapott a SAJÁT jegyzete miatt.
 *
 * EGY FORRÁS, EGY SZŰRÉS: a gate és a végállapot-döntés ugyanezt hívja.
 */
export function aiReviewAgentAdditions({ before, after }) {
  if (!(before instanceof Set) || !(after instanceof Set)) {
    throw new Error(
      'az AI-review növekménye nem MÉRT: a hunk finding-ID-k halmaza nem Set '
      + `(before=${JSON.stringify(before)}, after=${JSON.stringify(after)}).`,
    )
  }
  return [...after].filter((id) => !before.has(id) && !isUserNoteId(id))
}

export function aiReviewGateByIds({ before, after }) {
  if (!(before instanceof Set) || !(after instanceof Set)) {
    throw new Error(
      'az AI-review nem verifikálható: a hunk finding-ID-k halmaza nem MÉRT '
      + `(before=${JSON.stringify(before)}, after=${JSON.stringify(after)}). NEM töltünk fel semmit.`,
    )
  }
  // A TÖRLÉS-ELLENŐRZÉS IS CSAK AZ AGENT-FINDINGOKRA áll. A user a SAJÁT
  // megjegyzését SZABADON törölheti a TUI-ban (`c`-vel írta, `[x]`-szel zárja) —
  // az nem a session korrupciója, hanem a human-in-the-loop kapu működése. Ha
  // ezt is korrupciónak vennénk, a párhuzamos flow-ban a saját jegyzetét
  // rendezgető user MINDEN review-ját fail-closed hibára futtatnánk.
  const removed = [...before].filter((id) => !after.has(id) && !isUserNoteId(id))
  if (removed.length > 0) {
    throw new Error(
      `az AI-review a hunk sessionből TÖRÖLT kommentet (${removed.length} finding eltűnt: `
      + `${removed.slice(0, 3).join(', ')}${removed.length > 3 ? '…' : ''}). A review-agentnek `
      + 'nincs dolga a meglévő megjegyzésekkel — ez a session korrupciója, nem sikeres '
      + 'review. NEM töltünk fel semmit.',
    )
  }
  // AZ ÚJ ID-K KÖZÜL CSAK AZ AGENT-ÍRTAK SZÁMÍTANAK.
  //
  // MIÉRT KELL A SZŰRÉS (a teszt fogta el, valódi rés volt): a párhuzamos
  // modellben a USER is ír a sessionbe, miközben az agent dolgozik. Egy puszta
  // "új ID" tehát még nem AI-finding — ha a user írt egyet és az agent semmit, a
  // szűrés nélküli halmaz-diff "1 új finding"-ot, azaz SIKERES review-t állítana.
  // Pontosan az a hamis pozitív, amiért a darabszámos gate-et lecseréltük; a
  // halmaz-diff önmagában NEM oldja meg, csak a szűréssel együtt.
  //
  // A FELISMERÉS MÉRT (hunk 0.17.0): a hunk TUI-ban kézzel írt komment ID-je
  // `user:<epoch-ms>`, a CLI-vel (`comment apply`) írté `mcp:<uuid>:<n>`. A
  // `user:` prefix tehát a user-írás jele — és mivel a mérés a `--type agent`
  // szűrőn megy, ide user-komment amúgy sem juthatna: ez a MÁSODIK védelmi
  // vonal, ami egy jövőbeli típus-változás mellett is helyes marad.
  // A HALMAZ-DIFF A KÖZÖS FÜGGVÉNYBŐL: ugyanaz, amit a `doAiReview` a
  // `no-findings` végállapot eldöntéséhez hív. A duplikált számítás egyszer már
  // szétcsúszott (a `user:` szűrés lemaradt az egyik ágon) — lásd az
  // `aiReviewAgentAdditions` fejét.
  const addedIds = aiReviewAgentAdditions({ before, after })
  if (addedIds.length === 0) {
    throw new Error(
      'a claude -p sikeresen lefutott, de EGYETLEN ÚJ kommentet sem írt a hunk sessionbe '
      + `(${before.size} finding volt, ${after.size} van, 0 új). A sikeres burkoló ezt NEM `
      + 'zárja ki (mért csapda: exit 0 + subtype:"success" a le sem futott review-ra is '
      + 'jöhet), tehát a review NEM tekinthető lefutottnak. Ha az agent tényleg nem talált '
      + 'findingot, azt EXPLICITEN kell jelentenie.',
    )
  }
  return { added: addedIds.length, addedIds, before: before.size, after: after.size }
}


/**
 * A findings JSON Schema — a `--json-schema` ezzel validálja a modell válaszát.
 *
 * A séma NEM szabadon választott: a findingok a MEGLÉVŐ toGithubComments úton
 * mennek fel, ami a hunk A-sémáját (filePath/side/line/summary/rationale) várja.
 * A `side` ezért a hunk szókincse ('new'/'old'), nem a GitHubé (RIGHT/LEFT) — a
 * leképezés egy helyen, a toGithubComments-ben él.
 */
export function aiFindingsSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['filePath', 'side', 'line', 'summary'],
          properties: {
            filePath: { type: 'string', description: 'a fájl útja a repo gyökeréhez képest' },
            side: { type: 'string', enum: ['new', 'old'], description: 'a diff melyik oldala' },
            line: { type: 'integer', description: 'sorszám a post-image (new) vagy pre-image (old) fájlban' },
            summary: { type: 'string', description: 'egy mondat: mi a baj' },
            rationale: { type: 'string', description: 'opcionális hosszabb magyarázat' },
          },
        },
      },
    },
  }
}

/**
 * Az AI-review prompt. Repo-lokális skillre NEM hivatkozunk, mert a beépített
 * `/review` body-ja nem auditálható (nincs fájlként a diszken, verziótól
 * függően változhat), a hivatalos code-review plugin pedig `gh pr comment`-tel
 * MAGA posztol — saját formátumban, a mi attribúciónk nélkül —, tehát a
 * uploadFindings úttal inkompatibilis. Ezért a prompt itt, verziózva, a
 * repóban él, és EXPLICITEN megtiltja a posztolást.
 */
function aiReviewPrompt({ pr, scope }) {
  return [
    `Reviewold a #${pr} pull requestet. A diffet magad szedd le: \`gh pr diff ${pr}\``,
    'illetve fájlonként `gh pr diff` / `git diff` — a PR metaadatát `gh pr view`-val.',
    '',
    'CSAK az alábbi fájlokat reviewold (a többi generált fixture/lockfile, kihagyandó):',
    ...scope.map((f) => `  - ${f}`),
    '',
    PERMISSION_REALITY_INSTRUCTION,
    '',
    'A findingokat KIZÁRÓLAG a strukturált kimenetben add vissza — a feltöltésről',
    'a fejlesztő dönt, miután átnézte őket.',
    '',
    'A findings sémája (a `side` a diff oldala: "new" a post-image, "old" a pre-image;',
    'a `line` az adott oldal 1-alapú fájl-sorszáma, és a PR diffjében LÉTEZŐ sorra',
    'kell mutatnia — egy diffen kívüli sor az EGÉSZ review feltöltését megbuktatja).',
    '',
    'Valódi defekteket keress: korrektség, hibakezelés, race condition, biztonság,',
    'elnyelt hiba, hiányzó teszt kritikus úton. Stílus-megjegyzést NE adj.',
    'Ha nem találsz semmit, adj vissza üres findings tömböt — ne találj ki findingot.',
  ].join('\n')
}

/**
 * A `claude -p` hívás alakja. Külön, TISZTA függvény, hogy a flagek
 * (strukturált kimenet, séma, plafon, permission-mód) teszt alatt legyenek —
 * ezek elhagyása némán rontaná el a fail-closed szerződést.
 */
export function aiReviewCommand({ pr, scope, maxBudgetUsd, model }) {
  const args = [
    '-p', aiReviewPrompt({ pr, scope }),
    '--output-format', 'json',
    '--json-schema', JSON.stringify(aiFindingsSchema()),
    // A PLAFON OPCIONÁLIS, és defaultban NINCS. Ha nincs érvényes szám, a flag
    // EGYÁLTALÁN nem kerül az argv-be — se `undefined`-string, se 0, se
    // "unlimited". A `--max-budget-usd undefined` a claude oldalán parse-hiba, a
    // `0` pedig azonnal elvágott review; mindkettő rosszabb, mint a flag hiánya.
    ...budgetArgs(maxBudgetUsd),
    // Non-interaktívban a permission-prompt fejre állna (nincs, aki válaszoljon).
    // A `dontAsk` a szűkebb: a --tools listán kívülre nem is jut el.
    '--permission-mode', 'dontAsk',
    // A tool-felület szűkítve: a review-hoz olvasás és `gh` kell, írás NEM.
    // A `Skill` KELL: a review-utak skillt hívnak (lásd az agent-út indoklását).
    '--tools', 'Bash,Read,Grep,Glob,Skill',
    // A PERMISSION-ALLOWLIST (lásd az `AI_REVIEW_ALLOWED_TOOLS` fejét) és az
    // explicit deny (mutáló gh-utak — deny > allow, a lazítás ellen).
    ...AI_REVIEW_ALLOWED_TOOLS_ARGS,
    ...AI_REVIEW_DISALLOWED_TOOLS_ARGS,
    // IZOLÁCIÓ: a user-szintű CLAUDE.md kizárva (mérés: AI_REVIEW_SETTING_SOURCES).
    ...AI_REVIEW_SETTING_SOURCES_ARGS,
    // A MODELL MINDIG EXPLICIT — a default-öröklés a user mért lelete szerint
    // néma költség-eszkaláció (nála Fable 5 volt a mentett default).
    ...modelArgs(model),
  ]
  return ['claude', args]
}

/**
 * A `claude -p --output-format json` burkoló FAIL-CLOSED parse-olása.
 *
 * A gate-ek SORRENDJE szándékos: elsőként az exit-kód és a burkoló-szintű
 * hibajelzők, mert azok a legkonkrétabb magyarázatot adják; utána a
 * findings-parse, ami az EGYETLEN gate, ami a "sikeresnek látszó, de le sem
 * futott review"-t elkapja (lásd a fejezet-komment 1. pontját).
 *
 * MINDEN hibaút a NYERS kimenetet is visszaadja: a fejlesztőnek látnia kell,
 * mit mondott a modell — különben a "nem parse-olható" üzenet önmagában
 * diagnosztizálhatatlan.
 */
/**
 * A FŐ MODELL a `modelUsage` térképből: amelyik a MUNKÁT végezte.
 *
 * (wf31/69) A "fő" mérték a KÖLTÉS, másodsorban a kimenő tokenek: a segéd-hívások
 * (haiku a címkékhez, osztályozásokhoz) nagyságrendekkel kevesebbet fogyasztanak,
 * mint a review-t író modell. Nem a kulcs-sorrend dönt — lásd a hívási hely
 * indoklását.
 *
 * A KULCSNEVEKRE NEM TÁMASZKODUNK EGYETLEN ALAKBAN SEM: a `claude -p` burkoló
 * sémája verzióval változhat (`costUSD` / `costUsd` / `cost_usd`, `outputTokens` /
 * `output_tokens`), és egy néma kulcs-átnevezés visszahozná pontosan ezt a hibát.
 * Ezért mindegyik ismert alakot megnézzük, és ha EGYIK sem mérhető, a kulcs-sorrend
 * elsőjére esünk vissza (a wf31/69 ELŐTTI viselkedés) — az legalább nem rosszabb.
 *
 * FAIL-SAFE: hiányzó/érvénytelen `modelUsage` → `null`. A `reviewBody` a `null`
 * modellt nem írja hazug értékre, a hívó dönt a defaultról.
 */
function dominantModel(usage) {
  if (!usage || typeof usage !== 'object') return null
  const names = Object.keys(usage)
  if (names.length === 0) return null
  if (names.length === 1) return names[0]
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const pick = (keys) => {
    let best = null
    let bestVal = null
    for (const n of names) {
      const entry = usage[n]
      if (!entry || typeof entry !== 'object') continue
      const val = keys.map((k) => num(entry[k])).find((v) => v !== null) ?? null
      if (val === null) continue
      if (bestVal === null || val > bestVal) {
        bestVal = val
        best = n
      }
    }
    return best
  }
  return pick(['costUSD', 'costUsd', 'cost_usd'])
    ?? pick(['outputTokens', 'output_tokens'])
    ?? names[0]
}

export function parseAiReviewResult(stdout, status, stderr = '') {
  const raw = String(stdout ?? '')
  const clip = (s) => (s.length > 2000 ? `${s.slice(0, 2000)}…[csonkolva]` : s)

  if (status !== 0) {
    throw new Error(
      `a claude -p nem-nulla kóddal állt le (exit ${status}).\n`
      + `stderr: ${String(stderr ?? '').trim() || '(üres)'}\n`
      + `stdout: ${clip(raw.trim()) || '(üres)'}`,
    )
  }

  let env
  try {
    env = JSON.parse(raw)
  } catch {
    throw new Error(
      'a claude -p kimenete nem parse-olható JSON — NEM töltünk fel semmit.\n'
      + `nyers kimenet:\n${clip(raw)}`,
    )
  }

  // Három FÜGGETLEN hibajelző, mindhármat ellenőrizni kell: egyikük sem
  // implikálja a másikat, és egy modell-szintű kudarc exit 0-t is adhat.
  if (env.is_error === true) {
    throw new Error(`a claude -p hibát jelzett (is_error): ${clip(String(env.result ?? '(nincs result)'))}`)
  }
  if (env.api_error_status !== null && env.api_error_status !== undefined) {
    throw new Error(`a claude -p API-hibát jelzett: api_error_status=${env.api_error_status}`)
  }
  if (env.subtype !== undefined && env.subtype !== 'success') {
    throw new Error(`a claude -p nem sikeres subtype-pal állt le: subtype=${env.subtype}`)
  }
  if (Array.isArray(env.permission_denials) && env.permission_denials.length > 0) {
    throw new Error(
      `${denialMessage(env.permission_denials)} Ezért NEM töltünk fel semmit.`,
    )
  }

  // A findings a `result`-ban van, string-be szerializálva (--json-schema
  // mellett is): a burkoló result mezője szöveg. HA nem parse-olható vagy nincs
  // benne findings tömb, akkor a review NEM futott le — ez a legfontosabb gate.
  const resultText = typeof env.result === 'string' ? env.result : JSON.stringify(env.result ?? null)
  let parsed
  try {
    parsed = JSON.parse(resultText)
  } catch {
    throw new Error(
      'a claude -p sikeresnek jelzett burkolót adott, de a válasza NEM a kért findings-JSON '
      + '— a review tehát nem futott le. NEM töltünk fel semmit.\n'
      + `a modell válasza:\n${clip(resultText)}`,
    )
  }
  if (!parsed || !Array.isArray(parsed.findings)) {
    throw new Error(
      'a claude -p válaszában NINCS `findings` tömb — a review nem futott le (a sikeres '
      + 'burkoló ezt NEM zárja ki). NEM töltünk fel semmit.\n'
      + `a modell válasza:\n${clip(resultText)}`,
    )
  }

  // A séma-validáció a modell oldalán fut, de a burkolót MI olvassuk: egy
  // filePath nélküli comment 422-vel megbuktatná az EGÉSZ review-t a GitHubon,
  // tehát a hiányos findingot itt kell elkapni — átengedni NEM szabad.
  parsed.findings.forEach((f, i) => {
    if (typeof f?.filePath !== 'string' || f.filePath.length === 0) {
      throw new Error(`a ${i}. finding-ból hiányzik a filePath — így a GitHub 422-vel bukna az EGÉSZ review`)
    }
    if (typeof f.summary !== 'string' || f.summary.length === 0) {
      throw new Error(`a ${i}. finding-ból (${f.filePath}) hiányzik a summary — üres kommentet nem töltünk fel`)
    }
    if (f.side !== undefined && f.side !== 'new' && f.side !== 'old') {
      throw new Error(`a ${i}. finding side-ja érvénytelen: ${JSON.stringify(f.side)} (new|old)`)
    }
  })

  // A metaadat MÉRT, nem deklarált: a modell a `modelUsage`-ből (ez a TÉNYLEGESEN
  // használt modell), a költés a `total_cost_usd`-ből.
  //
  // (wf31/69) A `Object.keys(...)[0]` MÉRT SAJÁT HIBA VOLT. A user lelete: a TUI-ban
  // SONNET-et választott, a feltöltött review metaadatában mégis
  // `claude-haiku-4-5-20251001` szerepelt — `costUsd: 6.24` mellett, ami nem
  // haiku-nagyságrend, tehát a FUTÁS jó volt, a KIVÁLASZTÁS rossz.
  //
  // AZ OK: a `modelUsage` MINDEN modellt felsorol, amit a futás használt, nem csak
  // a fő modellt — a Claude Code a saját belső segédhívásaira (címke-generálás,
  // apró osztályozások, subagentek) haikut is hív a választott modell mellett. A
  // `[0]` tehát a JSON KULCS-SORRENDBEN elsőt vette, ami bármelyik lehet.
  //
  // MIÉRT NEM FOGTA EL TESZT: minden fixture EGYETLEN kulcsot tartalmaz
  // (`modelUsage: { 'claude-opus-5': {…} }`) — a hiba csak több modell mellett
  // látszik, és a `[0]` egy kulcsnál mindig helyes.
  const model = dominantModel(env.modelUsage)
  return {
    findings: parsed.findings,
    model,
    costUsd: env.total_cost_usd ?? null,
    sessionId: env.session_id ?? null,
    durationMs: env.duration_ms ?? null,
  }
}

/**
 * Az AI-review lefuttatása. A hívás a FUTTATÓ tokenjét fogyasztja, ezért a TUI
 * CSAK megerősítés után hívja (aiReviewBlockers + confirm-kapu).
 *
 * A `claude` hiányát itt IS ellenőrizzük (nem csak a blokkolóknál): egy ENOENT-es
 * spawnSync `status: null`-t ad, ami a naiv `status !== 0` ágon "exit null"
 * üzenetté fajulna — az nem magyarázó hiba.
 */
export function runAiReview({ pr, scope, maxBudgetUsd, model, cwd }) {
  const cp = claudePath()
  if (!cp) {
    throw new Error(
      'a `claude` CLI nem érhető el a PATH-on, ezért az AI-review nem futtatható. '
      + 'Telepítsd a Claude Code CLI-t (vagy tedd a PATH-ra), majd próbáld újra. '
      + 'Addig a hunk-diffes review (`d`) mindig működik.',
    )
  }
  const [cmd, args] = aiReviewCommand({ pr, scope, maxBudgetUsd, model })
  const res = spawnSync(cmd, args, { encoding: 'utf8', cwd, maxBuffer: 64 * 1024 * 1024 })
  if (res.error) throw new Error(`a claude -p nem indult el: ${res.error.message}`)
  return parseAiReviewResult(res.stdout, res.status, res.stderr)
}
