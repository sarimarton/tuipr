// tuipr — MERGE: akció-engedélyezés és merge-terv.
//
// Mit lehet approve-olni / mergelni, a blokkolók FELSOROLÁSA (nem csak az
// elsőé — a user az ÖSSZES okot akarja látni), a branch sorsa a prefix-
// konvenció szerint, és a branch-címke KÖZÉPSŐ csonkolása.
//
// RÉTEGREND: lefelé importál (layout: a branchLabel cellában mér). SEMMIT nem
// importál a core-ból vagy felette.
import { clampCells, displayWidth } from './layout.mjs'


// --- Akció-engedélyezés ----------------------------------------------------

/**
 * AZ APPROVE BLOKKOLÓI, FELSOROLVA — a `mergeBlockers` mintájára.
 *
 * (wf31/14) MIÉRT NEM A MODELL `canApprove` MEZŐJÉT HASZNÁLJUK TÖBBÉ, ÉS MIÉRT
 * ENGEDJÜK A MÁSODIK APPROVE-OT (a user kérdése: "Mi ennek az elvi akadálya?"):
 *
 * A bash `canApprove`-ja ÖT feltételt kér, és az egyik a `reviewDecision !=
 * "APPROVED"` — vagyis egy MÁR jóváhagyott PR-t a TUI nem engedett approve-olni.
 * A kódbázist végigolvasva erre NINCS kimondott indoklás (a `mergeBlockers`
 * MINDEN blokkolójánál ott áll a miért, itt nem), és elvi akadály sem áll:
 *   · a GitHub API ENGEDI (a `gh pr review --approve` működik);
 *   · ez egy NÉGY-SZEM-ELVŰ repo, tehát a második jóváhagyás ÖNÁLLÓ TÉNY — a
 *     `reviewDecision` marad `APPROVED`, de a `latestReviews` KÉT jóváhagyót
 *     mutat, ami audit-szempontból MÁS állapot (nem no-op);
 *   · a queue-nézet CÉLJÁVAL is szembement: a lista az approved PR-okat is
 *     mutatja (a teljes kép miatt), de egy második approve-hoz ki kellett lépni
 *     a TUI-ból.
 *
 * A SZABÁLY VALÓSZÍNŰ EREDETE a BULK út: egy `tuipr approve --all` NEM
 * zúghat végig a már jóváhagyott PR-okon (az szándék nélküli approve-áradat
 * lenne). Az a `--all` szemantikája viszont, nem az egy-PR-es, kurzorral
 * kiválasztott, MEGERŐSÍTŐ MODÁLLAL védett interaktív gesztusé. A bash
 * `classify_approvable`-je (és vele a `--all` szűrője) ÉRINTETLEN.
 *
 * AMI BLOKKOLÓ MARAD, mert MINDEGYIK VALÓDI AKADÁLY:
 *   · stacked — a sorsa a talapzatán dől el (a non-interaktív út `--base main`
 *     szűrője ezt a szerepet vitte; defenzíven itt is kell);
 *   · draft — nem is landolható, az approve értelmetlen;
 *   · sajátod — a GitHub maga ELUTASÍTJA (nem lehet a saját PR-odat approve-olni);
 *   · changes-requested — a kért módosítások előtt az approve hazug lenne.
 *
 * A FELSOROLÁS A LÉNYEG (nem csak a boolean): a régi UI EGYETLEN generikus
 * stringet adott — "nem approve-olható (sajátod / draft / stacked / már
 * eldöntött)" —, amiből a usernek KI KELLETT TALÁLNIA, melyik ok áll. Pontosan
 * ezért kérdezte meg. A `mergeBlockers` ezt a hibát nem követi el; innentől ez
 * sem.
 */
export function approveBlockers(r) {
  const out = []
  if (r.stackedOn !== null && r.stackedOn !== undefined) out.push('stacked PR — előbb a talapzata landoljon')
  if (r.isDraft) out.push('draft PR')
  // A SAJÁT PR: a `viewerIsAuthor` a modell MÉRT mezője. FAIL-SOFT a hiányára:
  // ha nem tudjuk (régi modell), NEM blokkolunk — a GitHub amúgy is elutasítja,
  // és egy kitalált blokkoló rosszabb, mint egy hangos szerver-oldali hiba.
  if (r.viewerIsAuthor === true) out.push('a sajátod — a GitHub nem engedi a saját PR approve-olását')
  if (r.reviewDecision === 'CHANGES_REQUESTED') {
    out.push('changes-requested review — a kért módosítások után újra kell kérni az approve-ot')
  }
  return out
}

/** Approve-olható-e — a blokkoló-lista üressége. Egy fogalom, egy forrás. */
export function canApproveRow(r) {
  return approveBlockers(r).length === 0
}

/**
 * A merge blokkolói, FELSOROLVA (nem csak az első) — a megerősítő prompt ezt
 * mutatja meg, hogy a user lássa, mi hiányzik.
 *
 * Miért nem elég a `landable`: a mergeMethod (branch-név konvenció) nem része a
 * landolhatóságnak, a merge-hez viszont kell — nem-konvencionális névnél a
 * landoló dönt, nem a TUI.
 */
// (wf31/22) A MERGE-GATE LEBONTVA: EGY BLOKKOLÓ (approve), A TÖBBI FIGYELMEZTETÉS.
//
// A USER DÖNTÉSE, szó szerint: "Ezt a blokkoló logikát vedd ki nagyon gyorsan.
// github UI enged merge-ölni, approve az egyetlen feltétel. Nem app logikából
// fogunk blokkolósdit játszani. Max warningokat hagyhatsz benne."
//
// MI VOLT A HIBA: a TUI SZIGORÚBB volt a GitHubnál, és ezt ki is mondta
// ("UNSTABLE — … a GitHub engedné, mi nem"). Egy kényelmi tool viszont nem
// dönthet a platform helyett: ha a GitHub UI-n le lehet mergelni, a TUI-ból is
// lehessen. A #895-ös eset mutatta meg a kárt: piros, NEM-REQUIRED checkek
// (Jira-transition, Determine Mode) tiltották le a merge-öt, holott a landolást
// egyik sem blokkolja.
//
// AZ EGYETLEN VALÓDI BLOKKOLÓ AZ APPROVE (a user kritériuma). A többi eset
// FIGYELMEZTETÉS: látszik a döntés előtt, de nem tilt.
//
// A `stacked`/`draft`/`mergeable`/`mergeMethod` IS CSAK FIGYELMEZTETÉS LETT, és ez
// szándékos: mindegyik olyan tény, amit a GitHub maga is elutasít (draft/stacked
// merge, konfliktusos PR), tehát a mi tiltásunk redundáns — a szerver-oldali
// elutasítás HANGOS és IGAZ, a mi kapunk viszont a fenti hibaosztályt termeli.

/**
 * A MERGE-T VALÓBAN MEGTAGADÓ okok. MA EGY van: nincs approve.
 *
 * KÜLÖN FÜGGVÉNY a `mergeWarnings`-tól, mert a KETTŐ MÁS DÖNTÉST szolgál: ez a
 * modál `denied` ágát nyitja (a `y` nem él), az pedig csak sorokat ír a döntés
 * fölé. Egy összevont lista pontosan azt az összemosást hozná vissza, amit ez a
 * változás megszüntet.
 */
export function mergeBlockers(r) {
  const out = []
  if (r.reviewDecision !== 'APPROVED') out.push('nincs approve')
  return out
}

/**
 * A MERGE FIGYELMEZTETÉSEI — látszanak a döntés előtt, de NEM tiltanak.
 *
 * A KONKRÉT CHECK-NEVEKET soroljuk fel, nem csak az aggregált szót. A CLI dry-run
 * ugyanezt teszi ("piros check: rebuild, Determine Mode, Type Check"), és a két
 * út nem divergálhat: a user pont az overlayen áll a döntés előtt, ott a "(red)"
 * önmagában semmit nem mond arról, MIT kell megjavítani.
 *
 * FALLBACK a névhiányra: ha a lista üres (régi modell, vagy a rollup adata
 * hiányzik), az aggregátumot írjuk ki. A jelzés SOSEM tűnhet el, és nevet
 * KITALÁLNI tilos — a "nem tudjuk, melyik" nem mosható össze a "nincs"-csel.
 */
export function mergeWarnings(r) {
  const out = []
  if (r.stackedOn !== null && r.stackedOn !== undefined) out.push('stacked PR — a talapzata még nyitva')
  if (r.isDraft) out.push('draft')
  if (r.checks !== 'green') {
    const named = r.checks === 'red' ? r.failedChecks : r.checks === 'pending' ? r.pendingChecks : null
    const label = r.checks === 'red' ? 'piros check' : 'még futó check'
    if (Array.isArray(named) && named.length > 0) out.push(`${label}: ${named.join(', ')}`)
    else out.push(`a CI nem zöld (${r.checks})`)
  }
  // A `UNSTABLE` A CHECK-SORBAN MÁR BENNE VAN (elhasalt nem-required check), tehát
  // külön sort NEM kap: a régi alak ("a GitHub engedné, mi nem") pontosan azt a
  // szigorúbb-vagyok-a-platformnál viselkedést hirdette, amit a user kivezetett.
  if (r.mergeStateStatus === 'BEHIND') out.push('BEHIND — a main elmozdult, rebase kellhet')
  if (r.mergeable !== 'MERGEABLE') out.push(`mergeable: ${r.mergeable}`)
  // MIKOR nincs mergeMethod? MIÓTA a nem-konvencionális név is a DEFAULT merge
  // commitot kapja (user-döntés: "a prefix az utasítás, default a merge commit"),
  // KIZÁRÓLAG ÜRES headRefName esetén — az pedig ADATHIÁNY, nem konvenció-kérdés.
  if (!r.mergeMethod) out.push('a PR head-branch neve ÜRES (adathiány) — a mergeMethod nem vezethető le')
  return out
}

export function canMergeRow(r) {
  return mergeBlockers(r).length === 0
}

/**
 * A BRANCH-NÉV megjelenítendő címkéje, CELLA-korlátra csonkolva.
 *
 * MIÉRT KELL EGYÁLTALÁN MEGJELENÍTENI (user-kérés, szó szerint): "az info boxban
 * ott merge method, ami tök jó, de pont nem látom a branch nevet sehol, pedig úgy
 * tudnám ellenőrizni, hogy jó-e a method. A branch neve amúgy is fontos info."
 * A `headRefName` MÁR benne volt a modellben — csak nem jelent meg.
 *
 * MIÉRT KÖZÉPEN VÁGUNK, és nem jobbra (ez a lényegi döntés):
 * a metódus a PREFIXBŐL következik (`squash-`/`rebase-`/minden más → merge
 * commit). Ha a szokásos jobbra-vágást használnánk, egy hosszú névnél pont az
 * elejét… nem, épp az elejét TARTANÁ meg — de a leíró VÉGE tűnne el, ami a PR
 * azonosításához kell. Ha viszont balra vágnánk, a PREFIX tűnne el, és a
 * user pont azt a jelet veszítené el, amivel a metódust ellenőrizni akarta.
 * Középen vágva MINDKETTŐ látszik: a prefix (a metódus forrása) és a névvég
 * (az azonosítás). Ez a formatter tehát nem stilisztika, hanem a user
 * ellenőrző-műveletének az adata.
 *
 * A MÉRTÉK CELLA, NEM KARAKTER (a `clampCells`-en keresztül): a user NÉGYSZER
 * jelentett be oszlop-csúszást. Egy branch-név ma ASCII, de semmi nem garantálja
 * (a git elfogad unicode ref-nevet), és egy karakter-alapú vágás egy emojis
 * névnél szétvinné az overlay keretét.
 *
 * ÜRES / HIÁNYZÓ névre BESZÉDES placeholder, nem üres string: az üres head
 * ADATHIÁNY (lásd a mergeBlockers megfelelő ágát), és egy üres sor az overlayen
 * úgy olvasódna, hogy nincs is ilyen mező. A "nem tudjuk" nem hallgatható el.
 */
export function branchLabel(head, cells) {
  if (typeof head !== 'string' || head === '') return '— (a head-branch neve nem tudható)'
  const limit = Math.max(0, Math.floor(Number(cells) || 0))
  if (limit === 0) return ''
  if (displayWidth(head) <= limit) return head
  // A csonkolás-jelző maga is helyet foglal. Ha a korlát olyan szűk, hogy a
  // jelző mellé érdemi szöveg nem fér, akkor a PREFIX nyer: a metódus forrása
  // az utolsó információ, amit feladunk (a névvég azonosít, a prefix DÖNT).
  const ELLIPSIS = '…'
  const ell = displayWidth(ELLIPSIS)
  if (limit <= ell + 1) return clampCells(head, limit)
  const room = limit - ell
  // Az eleje kapja a több helyet (a prefix a load-bearing rész), a vége a
  // maradékot. A `clampCells` garantálja, hogy surrogate párt nem hasítunk.
  const headRoom = Math.ceil(room / 2)
  const tailRoom = room - headRoom
  const start = clampCells(head, headRoom)
  // A VÉGET jobbról mérjük: fordított sorrendben csonkolunk, majd visszafordítunk.
  // A codepoint-tömbön (nem `.split('')`-en) fordítunk, hogy a surrogate párok
  // ne törjenek szét.
  const end = tailRoom > 0
    ? [...clampCells([...head].reverse().join(''), tailRoom)].reverse().join('')
    : ''
  const out = `${start}${ELLIPSIS}${end}`
  // FAIL-SAFE: ha a fenti számítás bármiért túllőne (a displayWidth
  // lookahead-szabálya a vágás-határon ragadhat egy VS16-ot), a végső mérték
  // itt dől el. Sosem adhatunk ki a korlátnál szélesebb címkét.
  return displayWidth(out) <= limit ? out : clampCells(out, limit)
}

/**
 * A LANDOLÁSI TERV, amit a megerősítő overlay megmutat: mi történik, ha a user
 * igent mond. A user három kérdést tett fel explicit módon:
 *   - milyen metódussal mergelünk (rebase-prefix → rebase merge, stb.)
 *   - mi lesz a branch-csel
 *   - mi lesz a commit-üzenet
 * Az overlay-nek mind a háromra válaszolnia kell, MÉG A GESZTUS ELŐTT.
 *
 * MIÉRT NEM HAJT VÉGRE SEMMIT: ez tiszta függvény — a végrehajtás a bash
 * `cmd_merge`-é, ami a repo-engedélyt és az állapot-gate-et is méri. Ez itt CSAK
 * a szándék leírása. A kettő nem divergálhat: a `deletesBranch` szabályát a
 * next-tui.test.ts visszaméri a bash `merge_deletes_branch`-ére.
 *
 * FAIL-CLOSED KÉT bemenetre, és mindkettő indokolt:
 *   - metódus (mergeMethod) nélkül `null`. Egy találgatott terv ("valószínűleg
 *     squash") azt a képet adná, hogy tudjuk, mi fog történni.
 *   - BRANCH-NÉV (headRefName) nélkül is `null`. A branch SORSA a prefixből jön;
 *     üres névre a `/^(squash|rebase)-/` false-ot ad, tehát a terv azt írná ki,
 *     hogy "a branch megmarad" — egy squash-PR-nál is, aminek a branche
 *     TÖRLŐDIK. Ez HAZUG overlay lenne (ugyanaz a hibaosztály, mint a mért
 *     tényt állító "(main-drift)" felirat volt), ezért inkább nincs terv.
 */
export function mergePlan(r) {
  if (!r || typeof r !== 'object') return null
  const method = r.mergeMethod
  if (method !== 'squash' && method !== 'rebase' && method !== 'merge') return null
  const head = r.headRefName
  if (typeof head !== 'string' || head === '') return null
  // A branch sorsa a PREFIXBŐL, nem a metódusból: a kettő normál esetben együtt
  // jár, de a prefix az igazság forrása (a bash is azt illeszti). Ha csak a
  // metódusra néznénk, egy `merge`-metódusú, mégis `squash-` nevű branch
  // (elvileg lehetetlen, de a modell nem zárja ki) más sorsot kapna itt, mint a
  // bashban — és a user az overlayen mást olvasna, mint ami történik.
  const deletesBranch = /^(squash|rebase)-/.test(head)
  return {
    method,
    // A METÓDUS EMBERI NEVE. Az élő render megmutatta, hogy a nyers kulcs
    // ragozhatatlan: a `merge` metódusból "metódus: merge merge" lett a
    // képernyőn. A GitHub UI szókincsét használjuk, mert a user ott látja
    // ugyanezt a három gombot.
    methodLabel: method === 'merge' ? 'merge commit'
      : method === 'squash' ? 'squash merge'
      : 'rebase merge',
    deletesBranch,
    branchFate: deletesBranch
      ? 'a branch törlődik (--delete-branch)'
      : 'a branch megmarad (ticketes branch — a changelog hivatkozik rá)',
    // A commit-üzenetet a GitHub repo-beállítása adja; NEM adunk --subject/--body-t.
    // Lásd a bash cmd_merge fejét: a squash/merge title+message a repo politikája,
    // és a changelog-generálás arra épül.
    commitMessage: 'a repo beállítása adja (nem írjuk felül)',
  }
}
