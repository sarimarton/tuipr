// tuipr — QUEUE-FETCH: az adatforrás-hívások (BESZERZÉS).
//
// Ami itt lakik: a queue (sync + async), a PR-refek fetchelése és a PR-fájlok
// mérete. KÜLÖN a diagnosis-tól, mert az az ÉRTELMEZÉS, ez a BESZERZÉS.
//
// RÉTEGREND: lefelé importál (proc: spawn-diagnózis, NEXT_SH, spawnCollect).
// SEMMIT nem importál a core-ból vagy felette.
//
// KÖZÖS ELV MINDEN HÍVÁSON: a spawn-HIBA (ENOENT) és a NEM-NULLA EXIT külön
// diagnózist kap, és a hiba DOBÓDIK — egy néma üres lista a hívót arra vezetné,
// hogy "nincs adat", holott a szerződés bukott el.
import { NEXT_SH, spawnCollect, spawnFailure } from './proc.mjs'
import { spawnSync } from 'node:child_process'

/** A queue --json EGYETLEN parse-olója — a szinkron és az aszinkron út közös magja. */
function parseQueueResult(res) {
  const spawnErr = spawnFailure(res, 'bash')
  if (spawnErr) throw new Error(`a queue nem kérdezhető le: ${spawnErr}`)
  if (res.status !== 0) {
    throw new Error(`queue --json hiba (exit ${res.status}): ${(res.stderr || res.stdout || '').trim() || '(nincs kimenet)'}`)
  }
  return JSON.parse(res.stdout)
}

/** `tuipr queue --json` → modell-tömb. */
export function fetchQueue() {
  return parseQueueResult(spawnSync('bash', [NEXT_SH, 'queue', '--json'], { encoding: 'utf8' }))
}

/**
 * A fetchQueue ASZINKRON párja — BÁJTRA ugyanaz a szerződés (parse, hibaszöveg),
 * csak az event loop marad szabad. A hunk-zárás utáni háttér-reload útja (5/2).
 */
export async function fetchQueueAsync() {
  return parseQueueResult(await spawnCollect('bash', [NEXT_SH, 'queue', '--json']))
}


/**
 * A PR head branch fetchelése egy lokális ref alá, hogy a hunk valódi
 * git-range-et lásson (a `gh pr diff | hunk patch -` úttal szemben ez adja a
 * fájl-szintű navigációt és a hunk-anchorokat).
 * Visszatér: [baseRef, headRef].
 */
export function fetchPrRefs(pr, remote = 'origin') {
  const ref = `refs/tuipr/pr/${pr}`
  const fetched = spawnSync('git', ['fetch', '-q', remote, `pull/${pr}/head:${ref}`], { encoding: 'utf8' })
  const fetchSpawnErr = spawnFailure(fetched, 'git')
  if (fetchSpawnErr) throw new Error(`a #${pr} fetchelése nem indítható: ${fetchSpawnErr}`)
  if (fetched.status !== 0) {
    // A stderr-t NEM interpoláljuk nyersen: spawn-hibán `undefined` lenne, és a
    // user egy "nem sikerült: undefined" sort kapna.
    throw new Error(`a #${pr} fetchelése nem sikerült (exit ${fetched.status}): ${(fetched.stderr || '').trim() || '(nincs stderr)'}`)
  }
  // A base-ref NEM eshet vissza némán 'main'-re. Stacked PR-nál a valódi base
  // egy MÁSIK PR head branche; ha egy tranziens gh-hiba (auth, rate limit,
  // részleges GraphQL válasz) után 'main'-t találgatnánk, a reviewer az
  // origin/main...head diffet kapná, ami a TALAPZAT-PR commitjait IS
  // tartalmazza — tehát nem azt a PR-t reviewolná, amit hisz, majd
  // approve-olná. A találgatás itt rosszabb, mint a hangos bukás.
  const baseJson = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'baseRefName', '--jq', '.baseRefName'], { encoding: 'utf8' })
  const baseSpawnErr = spawnFailure(baseJson, 'gh')
  if (baseSpawnErr) throw new Error(`a #${pr} base branch-e nem kérdezhető le: ${baseSpawnErr}`)
  if (baseJson.status !== 0) {
    throw new Error(`a #${pr} base branch-ének lekérése nem sikerült: ${(baseJson.stderr || '').trim() || `gh exit ${baseJson.status}`}`)
  }
  const base = (baseJson.stdout || '').trim()
  if (!base) throw new Error(`a #${pr} base branch-e üresen jött vissza a gh-tól — a base nem találgatható`)
  return [`${remote}/${base}`, ref]
}

/**
 * A PR fájl-listája mérettel (`gh pr view --json files`) — a megerősítő ekrán
 * ebből számol fájlszámot, +/- sorokat és scope-ot.
 *
 * Miért nem a `queue --json`-ból: az a modell szándékosan nem tartalmaz
 * méret-adatot (fájlonkénti additions/deletions), és nem is akarjuk oda betenni
 * — csak az AI-review-nak kell, PR-onként egyszer, on-demand.
 *
 * A hiba DOBÓDIK: egy néma üres fájl-lista a megerősítő ekrán "0 fájl, +0/-0"
 * képét adná, amiről a fejlesztő azt hinné, a PR triviális — és rábökne az y-ra.
 */
export function fetchPrFiles(pr) {
  const res = spawnSync(
    'gh',
    ['pr', 'view', String(pr), '--json', 'files', '--jq', '.files'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  // A SPAWN-HIBA ELŐBB, mint az exit-kód: ENOENT-en a status null és a stderr
  // üres, tehát a lenti ág "gh exit null"-t adott — HAZUG diagnózis (a gh nem
  // hibás exitet adott, hanem el sem indult).
  const spawnErr = spawnFailure(res, 'gh')
  if (spawnErr) throw new Error(`a #${pr} fájl-listája nem kérhető le: ${spawnErr}`)
  if (res.status !== 0) {
    throw new Error(`a #${pr} fájl-listája nem kérhető le: ${(res.stderr || '').trim() || `gh exit ${res.status}`}`)
  }
  const text = (res.stdout || '').trim()
  if (!text) throw new Error(`a #${pr} fájl-listája üresen jött vissza a gh-tól — a PR mérete nem találgatható`)
  const files = JSON.parse(text)
  if (!Array.isArray(files)) throw new Error(`a #${pr} fájl-listája nem tömb: ${text.slice(0, 200)}`)
  return files.map((f) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 }))
}
