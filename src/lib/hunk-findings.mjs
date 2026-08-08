// tuipr — HUNK-FINDINGS: a HIBRID findings-könyvelés (a session-halál ellen).
//
// A MEGFIZETETT HIBA, amiért ez a réteg létezik: a review lefutott (a
// token-költés MEGTÖRTÉNT), de a hunk-session a futás KÖZBEN megszűnt — a user
// épp azért lépett ki a hunkból, hogy a TUI-ban lássa a progresszt! —, és MINDEN
// finding elveszett. A "futtasd újra" pedig ÚJRAKÖLTÉS lett volna.
//
// Ezért a findingok KÉT könyvelést kapnak: a hunk-session (ha él) ÉS az agent
// végső válaszának strukturált JSON-blokkja. Ez a modul az utóbbi olvasása és
// későbbi betöltése.
//
// RÉTEGREND: lefelé importál (hunk: a session-hibaosztály és a hint; proc: a
// spawn-diagnózis). A hunk.mjs SEMMIT nem kér vissza innen — az irány
// egyirányú, a scripts/check-next-modules.mjs őrzi.
import { HUNK_SESSION_HINT, hunkBin, isNoActiveSession } from './hunk.mjs'
import { spawnFailure } from './proc.mjs'
import { spawnSync } from 'node:child_process'

// === HIBRID FINDINGS: dupla könyvelés a session-halál ellen ==================
//
// A MEGFIZETETT HIBA: a review lefutott (a token-költés megtörtént), de a
// hunk-session a futás KÖZBEN megszűnt (a user épp azért lépett ki a hunkból,
// hogy a TUI-ban lássa a progresszt!), és MINDEN finding elveszett — a
// "futtasd újra" pedig újraköltés lett volna.
//
// A HIBRID ARCHITEKTÚRA három lába:
//   (a) az agent a VÉGSŐ válaszában IS visszaadja a findingokat strukturáltan
//       (fenced ```json blokk, {"findings":[…]}) — ez a DUPLA KÖNYVELÉS;
//   (b) ha az agent a hunkba IS írt (élt a session), minden marad a régiben;
//   (c) ha a session megszűnt/nem volt, a findingok a válasz-JSON-ból jönnek:
//       a cache PR-ra kulcsolva eltárolja őket, és a hunk MEGNYITÁSAKOR a
//       `hunk session comment apply --stdin` batch-útján töltődnek be. A
//       betöltés IDEMPOTENS: az `applied` flag jegyzi, hogy megtörtént.
//
// MIÉRT A VÁLASZ-SZÖVEG FENCED JSON-JA, ÉS NEM `--json-schema`: a
// `--json-schema` a TELJES kimenetet kényszerítené sémára, ami üt a hunk-írás
// instrukcióval (az agentnek dolgoznia kell, nem csak válaszolnia), és a
// stream-json `result` mezője amúgy is a végső szöveg — abban a fenced blokk
// megbízhatóan parse-olható. A v1 (nem-agent) út `--json-schema`-ja marad,
// mert ott a válasz maga a termék.

/**
 * A VÁLASZ-FINDINGOK ÉS AZ ÖSSZEGZŐ kinyerése az agent végső szövegéből.
 *
 * HÁROM KIMENET, három JELENTÉSSEL:
 *   - `{ summary, findings }` — az agent adott strukturált blokkot; a `findings`
 *     üres tömbje a "nem találtam" GÉPI alakja (legitim), a `summary` `null`, ha
 *     az agent nem adott (vagy nem string/üres) összegzőt;
 *   - `null` — NINCS blokk: az agent nem tett strukturált állítást. Ez NEM
 *     üres lista — a hívó nem olvashatja "nincs finding"-ként;
 *   - DOBÁS — van blokk, de a séma sérült (pozíció/filePath/summary hiányzik).
 *     A néma átengedés a batch-apply-t buktatná meg (fail-closed), vagy rossz
 *     helyre tett kommentet adna.
 *
 * MIÉRT OBJEKTUM A VISSZATÉRÉS (wf24/2, a user "nem találok összegzést sehol"
 * lelete): a panel az EMBER-OLVASHATÓ összegzőt hiányolta, ami eddig SEHOL nem
 * létezett (a prompt sem kérte). A summary-t egy tömbre akasztott
 * nem-enumerálható mezőként is vissza lehetett volna adni, de az REJTETT
 * szerződés lenne — a JSON.stringify, a spread és a deepEqual mind elhullatná.
 * Ezért `{ summary, findings }`, MINDEN hívó átvíve.
 *
 * VISSZAFELÉ KOMPATIBILIS a MODELL felé (nem a hívók felé): summary NÉLKÜLI
 * (régi) alak, sőt CSUPASZ findings-TÖMB is elfogadott — a kifizetett review
 * findingjait egy séma-legyengülés nem veszejtheti el.
 *
 * TÖBB blokknál az UTOLSÓ findings-blokk nyer: az agent munka közben is
 * írhat ki JSON-t, a végső összegzés a mérvadó.
 */
export function parseAnswerFindings(text) {
  const src = typeof text === 'string' ? text : ''
  if (src.trim() === '') return null
  const candidates = []
  const fence = /```(?:json)?[ \t]*\n([\s\S]*?)```/gi
  let m
  while ((m = fence.exec(src)) !== null) candidates.push(m[1])
  // A TELJES válasz mint nyers JSON a LEGERŐSEBB jelölt (answer-only agent):
  // a lista végére kerül, mert hátulról iterálunk.
  candidates.push(src)
  let found
  let summary = null
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    let parsed
    try {
      parsed = JSON.parse(candidates[i].trim())
    } catch {
      continue
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.findings)) {
      found = parsed.findings
      summary = typeof parsed.summary === 'string' && parsed.summary.trim() !== ''
        ? parsed.summary.trim()
        : null
      break
    }
    // A CSUPASZ TÖMB (séma-legyengülés): az agent a burkoló objektumot
    // elhagyta. Elfogadjuk — a findingok kifizetettek, egy formai csúszás nem
    // dobhatja el őket. Összegző ilyenkor nincs.
    if (Array.isArray(parsed)) {
      found = parsed
      summary = null
      break
    }
  }
  if (found === undefined) return null
  const findings = found.map((f, i) => {
    if (typeof f?.filePath !== 'string' || f.filePath.trim() === '') {
      throw new Error(`a ${i}. válasz-findingból hiányzik a filePath — a batch-apply elhasalna rajta`)
    }
    if (typeof f.summary !== 'string' || f.summary.trim() === '') {
      throw new Error(`a ${i}. válasz-findingból (${f.filePath}) hiányzik a summary — üres kommentet nem töltünk be`)
    }
    const newLine = Number(f.newLine)
    const oldLine = Number(f.oldLine)
    const hasNew = f.newLine !== undefined && f.newLine !== null && Number.isInteger(newLine) && newLine > 0
    const hasOld = f.oldLine !== undefined && f.oldLine !== null && Number.isInteger(oldLine) && oldLine > 0
    if (!hasNew && !hasOld) {
      throw new Error(
        `a ${i}. válasz-findingnak (${f.filePath}) nincs pozíciója (newLine|oldLine) — `
        + 'pozíció nélküli findingot a hunk batch-apply fail-closed módon elutasít',
      )
    }
    const out = { filePath: f.filePath }
    // Ha MINDKETTŐ meg van adva (agent-slip), a post-image (newLine) nyer: az a
    // gyakoribb és a diff jobb oldala — a dobás itt egy teljes (kifizetett)
    // review-t veszejtene el egy redundáns mező miatt.
    if (hasNew) out.newLine = newLine
    else out.oldLine = oldLine
    out.summary = f.summary
    if (typeof f.rationale === 'string' && f.rationale.trim() !== '') out.rationale = f.rationale
    return out
  })
  return { summary, findings }
}

/**
 * A batch-apply STDIN-payloadja — a MÉRT séma (hunk 0.17.0):
 *   printf '{"comments":[{"filePath":"f.txt","newLine":5,"summary":"…"}]}' \
 *     | hunk session comment apply --repo <path> --stdin
 *   → "Applied 2 live comments", noteId `mcp:<uuid>:<n>`.
 *
 * A `rationale` a summary-hoz fűzve megy be: a mért apply-séma csak summary-t
 * hordoz, és az indoklás elvesztése rosszabb, mint az összefűzés.
 */
export function answerFindingsPayload(findings) {
  return JSON.stringify({
    comments: (Array.isArray(findings) ? findings : []).map((f) => ({
      filePath: f.filePath,
      ...(f.newLine !== undefined && f.newLine !== null ? { newLine: f.newLine } : { oldLine: f.oldLine }),
      summary: f.rationale ? `${f.summary}\n\n${f.rationale}` : f.summary,
    })),
  })
}

/**
 * A cache-elt válasz-findingok BETÖLTÉSE a (már élő) hunk sessionbe.
 *
 * FAIL-CLOSED minden ágon; a "nincs élő session" hibája KIMONDJA, hogy a
 * findingok a cache-ben MEGMARADTAK — a user nem hiheti, hogy elvesztek
 * (pontosan az a kár, ami ellen a hibrid réteg készült).
 *
 * ÜRES listára NEM hívunk hunkot: a 0 komment apply-a csak zaj.
 */
export function applyAnswerFindings(repoRoot, findings) {
  const list = Array.isArray(findings) ? findings : []
  if (list.length === 0) return 0
  const res = spawnSync(
    hunkBin(),
    ['session', 'comment', 'apply', '--repo', repoRoot, '--stdin'],
    { encoding: 'utf8', input: answerFindingsPayload(list) },
  )
  const spawnErr = spawnFailure(res, 'hunk')
  if (spawnErr) throw new Error(`a válasz-findingok betöltése nem indítható: ${spawnErr}`)
  if (res.status !== 0) {
    if (isNoActiveSession(res)) {
      // NEM a `review` kontextus szövege: az azt mondaná, "tokent NEM
      // költöttünk" — itt viszont a review MÁR LEFUTOTT, csak a betöltés bukott.
      throw new Error(
        `nincs élő hunk-session erre a repóra (${repoRoot}), ezért a válasz-findingok nem `
        + `tölthetők be. A findingok a cache-ben MEGMARADTAK (mind a ${list.length}) — a költés nem veszett el. `
        + `Mit tegyél: ${HUNK_SESSION_HINT}, aztán a betöltés újra felajánlható (Enter a PR-panelen).`,
      )
    }
    throw new Error(
      `a válasz-findingok betöltése a hunk sessionbe nem sikerült (exit ${res.status}): `
      + `${(res.stderr || res.stdout || '').trim() || '(nincs kimenet)'} — a findingok a cache-ben MEGMARADTAK.`,
    )
  }
  // A MÉRT sikersor: "Applied N live comments". Ha az alak változna, a
  // beküldött darabszám az őszinte fallback (exit 0 mellett).
  const applied = /Applied\s+(\d+)\s+live comment/i.exec(String(res.stdout ?? ''))
  return applied ? Number(applied[1]) : list.length
}
