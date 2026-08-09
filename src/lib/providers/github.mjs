// tuipr — GITHUB PROVIDER: a queue-modell előállítása `gh`-ból és `git`-ből.
//
// EZ A SZERZŐDÉS MÁSIK OLDALA. A TUI a queue-modellt KIZÁRÓLAG megjeleníti — a
// besorolást, a landolhatóságot és az approve-olhatóságot sosem számolja újra
// (lásd tui-core.mjs). Az a réteg tehát egy SZERZŐDÉS, nem egy implementáció
// belügye, és itt van a szerződés egy második megvalósítása: olyan, ami CSAK a
// `gh`-ra és a `git`-re támaszkodik, semmilyen munkahelyi branch-konvencióra.
//
// AMIT EZ A PROVIDER SZÁNDÉKOSAN NEM AD:
//   - `classification` (a conflict-diagnózis numerikus szintje) és `dep` — ezek
//     MÉRÉSBŐL származnak (merge-tree szimuláció), nem lekérdezésből;
//   - `stackedOn` / `stackRoot` / `stackDepth` — a stackelés egy integrációs
//     branch merge-üzeneteiből olvasható ki, ami itt nincs.
// A fogyasztó ezekre FAIL-SAFE (rows.mjs `depthOf`/`rootOf`): hiányukban lapos,
// egyszintű lista jön. Ezért NEM hazudunk nullát oda, ahol nincs mérésünk — a
// hiányzó mező „nem tudjuk", a `0` viszont „megmértük és nincs" lenne.
//
// RÉTEGREND: lefelé importál (proc: spawn-diagnózis). SEMMIT nem importál a
// core-ból vagy felette.
import { spawnCollect, spawnFailure } from '../proc.mjs'
import { spawnSync } from 'node:child_process'

/**
 * A `gh pr list` mezői. SZŰKEN tartva: minden mező külön GraphQL-munkát jelent
 * a szerveren, és a `files` a legdrágább — azt csak akkor kérjük, ha tényleg
 * kell (a dep-metszet a mérő providerben él, nem itt).
 */
const PR_FIELDS = [
  'number',
  'title',
  'isDraft',
  'headRefName',
  'baseRefName',
  'mergeable',
  'mergeStateStatus',
  'reviewDecision',
  'author',
].join(',')

/**
 * A besorolás LEKÉRDEZÉSBŐL, nem mérésből — és ezt a különbséget a
 * mezőnevek is hordozzák.
 *
 * MIÉRT NEM ELÉG a `mergeable`: a GitHub `CONFLICTING`/`MERGEABLE`/`UNKNOWN`
 * hármasa a BASE-szel szembeni állapot. Az `UNKNOWN` nem hiba, hanem
 * „a szerver még számol" — ilyenkor a `mergeStateStatus` a beszédesebb, és a
 * kettőt EGYÜTT kell nézni, különben egy épp frissülő PR-t hamisan
 * konfliktusosnak jelentenénk.
 */
function classify(pr) {
  if (pr.isDraft) return 'draft'
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return 'conflict'
  // A `BLOCKED` ÖNMAGÁBAN NEM jelent blokkolt PR-t — MÉRT lelet a cli/cli
  // nyitott PR-jein: ott MINDEGYIK `BLOCKED`, mert a repó kötelező review-t ír
  // elő, és a review még nincs meg. Ez a REVIEW-RA VÁRÓ, teljesen normális
  // állapot, azaz pontosan az, amiért ez a tool létezik.
  //
  // Ha ezt `blocked`-nak jelentenénk, az EGÉSZ lista ⛔ lenne, és a jelzés nem
  // különböztetne meg semmit — ugyanaz a hibaosztály, amit a rows.mjs a
  // mindenhol kitett ⬆️-nál már egyszer kiirtott. Ráadásul a review-állapotot
  // a SAJÁT oszlopa (rmark) már kimondja, tehát duplikálnánk is.
  //
  // Blokkolt tehát az, amit EMBER állított meg: a kért változtatás.
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'blocked'
  if (pr.mergeStateStatus === 'UNKNOWN' && pr.mergeable === 'UNKNOWN') return 'missing'
  return 'queue'
}

/**
 * Approve-olható-e ÁLTALUNK. A saját PR-t a GitHub sem engedi jóváhagyni,
 * tehát ezt nem is ajánljuk fel — a fail-closed irány itt a `false`.
 */
function canApprove(pr, viewer) {
  if (pr.isDraft) return false
  if (viewer && pr.author?.login === viewer) return false
  if (pr.reviewDecision === 'APPROVED') return false
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return false
  return true
}

/**
 * A repó által ENGEDÉLYEZETT merge-metódus. Egy hívás, mert a válasz a repóra
 * jellemző, nem PR-enként változik.
 *
 * FAIL-SOFT, SZÁNDÉKOSAN: ha a lekérdezés nem megy (jogosultság, offline), a
 * `merge`-öt adjuk vissza — az a GitHub alapértelmezése is. Egy nem-kritikus
 * kiegészítő mező miatt a TELJES listát megtagadni aránytalan lenne.
 */
function repoMergeMethod() {
  const res = spawnSync(
    'gh',
    ['repo', 'view', '--json', 'squashMergeAllowed,rebaseMergeAllowed,mergeCommitAllowed'],
    { encoding: 'utf8' },
  )
  if (spawnFailure(res, 'gh') || res.status !== 0) return 'merge'
  try {
    const r = JSON.parse(res.stdout)
    if (r.mergeCommitAllowed) return 'merge'
    if (r.squashMergeAllowed) return 'squash'
    if (r.rebaseMergeAllowed) return 'rebase'
  } catch {
    return 'merge'
  }
  return 'merge'
}

/** A bejelentkezett felhasználó login-neve, vagy `null`, ha nem megállapítható. */
function viewerLogin() {
  const res = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' })
  if (spawnFailure(res, 'gh') || res.status !== 0) return null
  return res.stdout.trim() || null
}

/**
 * A `gh pr list --json` kimenetének EGYETLEN parse-olója — a szinkron és az
 * aszinkron út közös magja.
 *
 * A HIBA DOBÓDIK, nem nyelődik el: egy néma üres lista a hívót arra vezetné,
 * hogy „nincs nyitott PR", holott a szerződés bukott el. Ez ugyanaz az elv,
 * ami az eredeti provider minden hívásán érvényes volt.
 */
function parsePrList(res) {
  const spawnErr = spawnFailure(res, 'gh')
  if (spawnErr) throw new Error(`a PR-lista nem kérdezhető le: ${spawnErr}`)
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim() || '(nincs kimenet)'
    throw new Error(`gh pr list hiba (exit ${res.status}): ${detail}`)
  }
  try {
    return JSON.parse(res.stdout)
  } catch (err) {
    throw new Error(`a gh pr list kimenete nem JSON: ${err.message}`)
  }
}

/** Nyers `gh`-PR → queue-modell sor. */
function toRow(pr, { viewer, mergeMethod }) {
  return {
    number: pr.number,
    title: pr.title,
    state: classify(pr),
    isDraft: Boolean(pr.isDraft),
    reviewDecision: pr.reviewDecision || null,
    canApprove: canApprove(pr, viewer),
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    mergeMethod,
    author: pr.author?.login ?? null,
  }
}

function listArgs(limit) {
  return ['pr', 'list', '--state', 'open', '--limit', String(limit), '--json', PR_FIELDS]
}

/**
 * `gh pr list` → queue-modell tömb.
 *
 * A `limit` MAGAS alapértéke szándékos: a `gh` alapértelmezett 30-a egy aktív
 * repóban CSENDBEN vágná el a listát, és a hiányzó PR-ek hiánya nem tűnik fel
 * — pontosan az a hibaosztály, amit a néma üres listánál is kerülünk.
 */
export function fetchQueue({ limit = 200 } = {}) {
  const viewer = viewerLogin()
  const mergeMethod = repoMergeMethod()
  const prs = parsePrList(spawnSync('gh', listArgs(limit), { encoding: 'utf8' }))
  return prs.map((pr) => toRow(pr, { viewer, mergeMethod }))
}

/**
 * A fetchQueue ASZINKRON párja — BÁJTRA ugyanaz a szerződés (alak, hibaszöveg),
 * csak az event loop marad szabad.
 */
export async function fetchQueueAsync({ limit = 200 } = {}) {
  const viewer = viewerLogin()
  const mergeMethod = repoMergeMethod()
  const prs = parsePrList(await spawnCollect('gh', listArgs(limit)))
  return prs.map((pr) => toRow(pr, { viewer, mergeMethod }))
}
