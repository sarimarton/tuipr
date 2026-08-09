// tuipr — DIAGNOSIS: a conflict-diagnózis ÉRTELMEZÉSE és a progresszív mérés.
//
// Ami itt lakik: a diagnózis → ajánlás leképezés (a FANTOM-CULPRIT szemantika),
// a dep-jelzés magyarázata (`i`), a progresszív mérés állapotgépe + NDJSON-
// olvasó + a mérés-indító, és az info-modell.
//
// RÉTEGREND: lefelé importál (merge: a landolhatóság blokkolói; proc: spawn-
// diagnózis és NEXT_SH). SEMMIT nem importál a core-ból vagy felette.
//
// KÜLÖN A QUEUE-FETCH-TŐL: az adatforrás-hívás a BESZERZÉS, ez az ÉRTELMEZÉS.
// A `fetchDiagnosis` MÉGIS itt van, mert a `conflict --json` szerződése és a
// belőle olvasó `conflictAdvice` EGY témát alkot — a mérést a TUI NEM
// implementálja újra, csak a subcommandot hívja.
import { canMergeRow, mergeBlockers } from './merge.mjs'
import { NEXT_SH, spawnFailure } from './proc.mjs'
import { spawn, spawnSync } from 'node:child_process'

// --- Conflict-diagnózis → ajánlás ------------------------------------------

/**
 * Az `tuipr conflict --json` diagnózisából a TUI teendő-ajánlása.
 *
 * A stackelés-ajánlás szabálya MÉRÉSEN alapul (a recon az éles #911-en
 * kipróbálta): CSAK akkor ajánljuk, ha
 *   (a) a main-nel NINCS conflict — különben előbb a main-re rebase kell, és
 *       a stackelés csak elodázná a valódi bajt, illetve
 *   (b) PONTOSAN EGY culprit van — a stackelés egyszerre egyetlen PR-ra tud
 *       mutatni, tehát több culpritnál eleve részleges. A #911-en négy culprit
 *       volt, és a mérés szerint mind a négyet bázisba téve (composite base) IS
 *       maradt conflict: ott a stackelés HAMIS biztonságot adott volna, a helyes
 *       válasz a queue-sorrend kivárása.
 *
 * Amit NEM ellenőrzünk itt, szándékosan: hogy az ütköző fájl generált/lock fájl-e
 * (`pnpm-lock.yaml`, `package.json`), és hogy a culprit talapzat maga
 * blokkolt-e. Ezek a recon szerint további kizáró okok, de a megítélésük a
 * useré — a `summary` megnevezi a fájlokat, hogy LÁSSA, mibe stackelne.
 * A stackelés amúgy is csak megerősítéssel fut le.
 */
export function conflictAdvice(diag) {
  // A LANDOLHATÓ culpritok: csak azokra lehet stackelni, és a queue-sorrend is
  // csak őket oldja fel. A `candLandable === false` jelölt a main-nel ütközik,
  // tehát a CI skippeli — sosem lesz a next része. (Ha a mező hiányzik, a régi
  // szerződés szerinti diagnózist kapjuk: ott nem mértük, ezért nem is
  // állíthatjuk, hogy nem landol → landolhatónak vesszük.)
  const all = diag.queueConflicts ?? []
  const landable = all.filter((c) => c.candLandable !== false)
  const unlandable = [
    ...all.filter((c) => c.candLandable === false),
    ...(diag.phantomConflicts ?? []),
  ]
  const culprits = landable.map((c) => c.number)
  const named = landable.map((c) => `#${c.number} (${c.files.join(', ')})`).join(', ')
  // A FANTOMOKAT megnevezzük, de NEM teendőként: a user látja a next-conflict
  // labelt, és tudni akarja, miért nincs vele dolga.
  const phantomNote = unlandable.length === 0
    ? ''
    : ` Megjegyzés: ${unlandable.map((c) => `#${c.number}`).join(', ')} szintén ütközik veled, `
      + 'de ő maga sem landolható (a main-nel conflictol), tehát a next-be sem épül be — teendő vele nincs.'
  // A MÉRÉS SZEMANTIKÁJA vs. a CI művelete. A próba `git merge-tree`-vel
  // MERGE-öt szimulál (net diff), a CI viszont commitonként REBASE-el
  // (NEXT_STRATEGY: rebase, merge-fallback nélkül). MÉRVE: egy módosít-majd-
  // visszaállít PR-on a merge-tree exit 0 (CLEAN), a `git rebase` viszont
  // CONFLICT + exit 1. Ezt a különbséget minden nem-blokkoló verdictnél ki kell
  // mondani, különben "nincs teendő"-t olvas a user, ahol van.
  //
  // MIÉRT KÜLÖN MEZŐ, ÉS MIÉRT NEM A SUMMARY VÉGÉN (a régi alak): a caveat
  // MINDEN nem-blokkoló verdicten SZÓ SZERINT UGYANAZ — a user bejelentése
  // szerint ez warning fatigue-ot termel (a negyedik PR-nál már át sem olvassa).
  // A panel ezért progresszív disclosure-rel rejti el (csukott lábjegyzet-sor +
  // Enter), ÉS EZ CSAK ÚGY LEHETSÉGES, ha a caveat NEM ugyanabban a stringben ül,
  // mint a TEENDŐ (stackelés-ajánlás, "várd meg a #N landolását"). A régi kód
  // NÉGY helyen fűzte be konkatenációval; a disclosure ott vagy a teendőt is
  // elrejtette volna, vagy a nézetnek regexszel kellett volna kihasítania a
  // caveatet — az pedig egy MÁSODIK, elcsúszó szöveg-forrás.
  //
  // AZ ALAK `{ text, command }`: a PARANCS külön áll, mert a nézet CYAN sorban
  // rendereli (a panel minden más végrehajtandó parancsát is így írja). A
  // parancsnak MEG KELL MARADNIA valamilyen alakban a csukott állapotban is —
  // ez a UI EGYETLEN helye, ahol a `git rebase origin/next` felszólítás
  // elhangzik, és MÉRT tényen áll (merge-tree exit 0 vs. git rebase CONFLICT).
  //
  // A `--json` út NEM ÉRINTETT: ott a bash `recommendation` mezője beszél, ami
  // külön szöveg, és a caveatjét maga hordozza.
  //
  // (wf31/4) A `detail` MEZŐ: a VERDICT-REDUNDANCIA HELYE. A user lelete, szó
  // szerint: "A Verdict clean ugyanaz, mint a »nem talált conflictot«, tehát a
  // »nem talált conflictot« már elrejtendő részlet."
  //
  // A MÉRT DUPLIKÁCIÓ a clean-panelen NÉGY sor, HÁROM azonos állítással:
  //     ✓ main: nincs conflict
  //     ✓ next-en belül: nincs ütközés (4 jelölt megmérve)
  //     Verdict: clean
  //     A merge-tree próba NEM talált conflictot (4 jelölt megmérve) — se a
  //     main-nel, se a queue-ban előtte állókkal.
  // A negyedik sor a fölötte lévő HÁROM ÖSSZEGZÉSE, új információ nélkül: a
  // "NEM talált conflictot" = a `Verdict: clean`, a "se a main-nel, se a
  // queue-ban előtte állókkal" = pontosan a két mérési sor.
  //
  // A MEGOLDÁS A MEGLÉVŐ DISCLOSURE-T HASZNÁLJA, nem újat épít: a szöveg a
  // `caveat.detail`-be kerül, amit a `caveatLines` a NYITOTT ágon renderel
  // (Enter-toggle). Csukva marad a `Verdict: clean` + az egysoros `…`
  // affordance — pontosan az, amit a user kért.
  //
  // MIÉRT NEM TÖRÖLTEM: a jelölt-szám (`N jelölt megmérve`) a MÉRÉS
  // TERJEDELMÉT mondja ki, ami attesztációs tény — az elrejtés nem törlés. A
  // `detail` mező tehát ELREJT, de MEGŐRIZ.
  //
  // MIÉRT A CAVEAT-BLOKKBA, ÉS MIÉRT NEM EGY HARMADIK TOGGLE-BA: a caveat
  // ugyanarról a MÉRÉSRŐL beszél (mit szimulált, mit nem lát), a `detail` pedig
  // annak a mérésnek az EREDMÉNYE. Egy második, konkurrens toggle ugyanarra a
  // fogalomra két kulcsot kívánna a már telített készletben.
  const probeCaveat = {
    text: 'A mérés MERGE-öt szimulál, a CI viszont REBASE-el — commit-szintű '
      + 'ütközést ez a próba nem lát. A biztos válasz:',
    command: 'git rebase origin/next <branch>',
    // A `detail` az ÁG-SPECIFIKUS mérési eredmény — a `clean` ágon a
    // "nem talált conflictot" mondat kerül ide (lásd ott). A többi ágon `null`:
    // ott a summary TEENDŐT hordoz (stackelés, rebase), nem redundanciát.
    detail: null,
  }

  // A STACKELT PR-t a subcommand nem mérte meg (a sorsa a talapzatán dől el), és
  // a diagnózisa üres queueConflicts + mainConflict=false — vagyis a naiv
  // ágsorrend "nincs mért conflict"-ot mondana, ami HAZUG: nem is mértünk. Ez
  // ugyanaz a hibaosztály, mint a "(main-drift)" felirat volt, ezért ez az ág
  // MINDEN más előtt áll.
  if (diag.verdict === 'stacked') {
    const on = diag.stackedOn === null || diag.stackedOn === undefined
      ? `a(z) ${diag.baseRef} branch`
      : `a #${diag.stackedOn}`
    return {
      offerStack: false,
      stackOn: null,
      command: null,
      // NINCS CAVEAT: a stackelt PR-t NEM IS MÉRTÜK, tehát a merge-vs-rebase
      // eltérésnek itt nincs mire vonatkoznia. A `null` (nem `''`) a nézetnek
      // GÉPI válasz a "van-e lábjegyzet?" kérdésre — üres stringből egy üres,
      // dimmelt lábjegyzet-sor renderelődött volna.
      caveat: null,
      summary: `Ez egy STACKELT PR: ${on} a talapzata, tehát a sorsa ott dől el — a next a talapzatán keresztül tartalmazza. Diagnosztizáld a talapzatot.`,
    }
  }
  if (diag.mainConflict) {
    return {
      offerStack: false,
      stackOn: null,
      command: null,
      // NINCS CAVEAT: itt a rebase MAGA a teendő (a summary ki is mondja), nem
      // egy mérési fenntartás. Lábjegyzetbe tenni azt jelentené, hogy a
      // legfontosabb teendőt rejtjük el.
      caveat: null,
      summary: `VALÓDI conflict a main-nel: ${(diag.mainConflictFiles ?? []).join(', ')} — ez blokkolja a landolást. Rebase-eld main-re.`,
    }
  }
  if (culprits.length === 0) {
    // KÜLÖN ÁG, ha MÉRTÜNK conflictot, de MINDEN culprit fantom. A "NEM talált
    // conflictot" szöveg itt HAZUG lenne: találtunk, csak a culpritok maguk sem
    // landolnak. A user a next-conflict labelt látja — magyarázatot érdemel.
    if (unlandable.length > 0) {
      const namedPhantoms = unlandable.map((c) => `#${c.number} (${c.files.join(', ')})`).join(', ')
      return {
        offerStack: false,
        stackOn: null,
        command: null,
        caveat: probeCaveat,
        summary: `A main-nel NINCS conflict — a landolásod nincs veszélyben. A next-en ütközöl `
          + `(${namedPhantoms}), DE egyik ütköző PR sem landolható maga sem (mind a main-nel `
          + `conflictol), tehát a next-be sem épülnek be. Teendő: nincs a te oldalon — a `
          + `next-conflict label a következő rebuildig maradhat.`,
      }
    }
    return {
      offerStack: false,
      stackOn: null,
      command: null,
      // (wf31/4) A MÉRÉS EREDMÉNYE A CAVEAT `detail`-JÉBE KERÜLT, a summary ÜRES.
      //
      // A user: "A Verdict clean ugyanaz, mint a »nem talált conflictot«, tehát a
      // »nem talált conflictot« már elrejtendő részlet." A mondat a fölötte lévő
      // HÁROM sort (a két mérési sort + a `Verdict: clean`-t) összegezte, új
      // információ nélkül — a redundancia MÉRHETŐ, nem vélemény.
      //
      // (wf31/32) KÉT ÚT, KÉT SZÖVEG — ÉS A `ci` ÁGON NINCS CAVEAT.
      //
      // `nextFrom: 'ci'` — a PR BENT VAN a next-ben, tehát a CI KUMULATÍV
      // rebase-e átment rajta. A merge-vs-rebase fenntartás itt NEM alkalmazható:
      // a CI TÉNYLEGESEN rebase-elt, nem mi szimuláltunk merge-öt. Egy odaírt
      // caveat azt sugallná, hogy bizonytalanabbak vagyunk, mint amilyenek — és
      // pontosan azt a fenntartás-inflációt termelné, amit a user máshol is
      // kifogásolt. A `detail` viszont KIMONDJA, honnan tudjuk.
      //
      // `nextFrom: 'probe'` — LOKÁLIS páros merge-tree. Itt a caveat KÖTELEM (a
      // próba merge-öt szimulál, a CI rebase-el), és a jelölt-szám is releváns.
      caveat: diag.nextFrom === 'ci'
        ? {
            // A `text`/`command` ELMARAD: nincs fenntartás, amit ki kellene
            // mondani, és egy `git rebase origin/next` felszólítás egy MÁR
            // beépült PR-on értelmetlen teendő lenne.
            text: '',
            command: '',
            detail: 'A main-nel NINCS conflict (mérve), a next-be pedig MÁR BEÉPÜLT — '
              + 'a CI kumulatív rebase-e átment rajta. A queue-belső prefixet ezért '
              + 'nem kellett megmérni.',
          }
        : {
            ...probeCaveat,
            detail: `A merge-tree próba NEM talált conflictot (${diag.probed} jelölt megmérve) — `
              + `se a main-nel, se a queue-ban előtte állókkal.`,
          },
      // AZ ÜRES STRING, NEM `null`: a mező TÍPUSA marad string (a `--json` út és
      // a többi ág is stringet ad), tehát egyetlen fogyasztónak sem kell
      // null-ágat írnia. A NÉZET pedig az üres summary-ból NEM SZÜL SORT
      // (`infoBody`) — egy üres sor-leíró ugyanazt a MAGASSÁGOT vinné el, mint
      // egy tartalmas, és a `clipBodyLines` MEGJELENÍTETT sorokat számol
      // (a wf28/3-as gap-sor hibaosztálya).
      summary: '',
    }
  }
  if (culprits.length === 1) {
    const on = culprits[0]
    return {
      // (wf31/68) A MEZŐ NEVE TÖRTÉNETI — MÁR NEM AJÁNLAT, HANEM CÉL-JELÖLÉS.
      //
      // A `true` innentől annyit jelent: VAN egyértelmű stack-cél (pontosan egy
      // landolható culprit), tehát a TUI fel tudja kínálni az `s` gombot. A
      // SZÖVEG viszont nem ajánl — lásd a summary indoklását.
      offerStack: true,
      stackOn: on,
      // A végrehajtás a MEGLÉVŐ publish úton megy — nincs párhuzamos
      // stackelés-implementáció a TUI-ban.
      command: `tuipr publish --stack-on ${on}`,
      caveat: probeCaveat,
      // (wf31/68) A "A STACKELÉS VALÓSZÍNŰLEG FELOLDJA" ÍGÉRET KIVEZETVE —
      // MÉRT SAJÁT HIBA, ÉS NEM BIZONYTALANSÁG, HANEM TÉVEDÉS VOLT.
      //
      // A user kérdése: "ha a conflict feloldást igényel, akkor minek ajánlunk
      // fel stackelést? Nem segít semmin." — és a kódból levezetve igaza van,
      // STRUKTURÁLISAN:
      //
      //   · a `queueConflicts` KIZÁRÓLAG valódi culpritokat tartalmaz (a bash
      //     `$real` ága: akikkel a merge-tree conflictot MÉRT);
      //   · tehát `culprits.length === 1` ⟹ VAN tartalmi ütközés a céllal;
      //   · tehát a rá rebase-elés KÉZI FELOLDÁST igényel — mindig.
      //
      // Vagyis nem létezik olyan eset, amikor a felajánlott stackelés tisztán
      // lefutna. A "valószínűleg" nem élesíthető méréssel: az állítás maga hamis.
      // (Élesben ellenőrizve a #911 → #904 párra: a merge-tree ugyanazt az egy
      // fájlt adta, mint a száraz rebase, ami a 74. commitnál conflictolt.)
      //
      // AMIT A STACKELÉS VALÓJÁBAN TESZ: előrehozza ugyanazt a feloldást, amit a
      // "várd meg a landolását" úton is el kell végezni — cserébe a PR a cél
      // landolásáig KIKERÜL A NEXT-BŐL (a next-rebuild `--base main`-t szűr,
      // egy stackelt PR base-e pedig nem main). Ez utóbbi eddig sehol nem
      // szerepelt, és a user joggal hitte az ellenkezőjét.
      //
      // EZÉRT A SUMMARY MOST TÉNYT MOND, NEM TEENDŐT: a két út és az áruk. Hogy
      // funkcionálisan rá épülsz-e, azt a gép NEM tudja — az a te döntésed, és a
      // szöveg nem tesz úgy, mintha helyetted eldöntené.
      summary: `A main-nel NINCS conflict — a landolásod nincs veszélyben. A next-en a ${named} PR-ral `
        + `ütközöl. A feloldás elkerülhetetlen: vagy MOST, a #${on}-re stackelve (a rebase ugyanezekben a `
        + `fájlokban conflictol, és a PR a #${on} landolásáig kikerül a next-ből), vagy a #${on} landolása `
        + `UTÁN, main-re rebase-elve. A #${on} a main-nel MÉRVE nem ütközik, tehát stack-célként landolhat.`
        + `${phantomNote}`,
    }
  }
  return {
    offerStack: false,
    stackOn: null,
    command: null,
    caveat: probeCaveat,
    // (wf31/68) ITT SEM ÍGÉRÜNK — ugyanaz a javítás, mint az egy-culpritos ágon.
    //
    // A "queue-sorrend valószínűleg feloldja" ugyanúgy hamis volt: a next-rebuild
    // KUMULATÍVAN rebase-el, tehát a culpritok beépülése UTÁN a mi PR-unk rebase-e
    // pontosan ugyanazokba a tartalmi ütközésekbe fut — kiesik (skipped), amíg a
    // szerző fel nem oldja. A sorrend nem old fel semmit, csak elhalasztja.
    summary: `A main-nel NINCS conflict. A next-en ${culprits.length} PR-ral ütközöl: ${named}. `
      + `Stackelni nem tudsz (egy PR egyszerre egy bázisra mutat) — a feloldás a culpritok landolása `
      + `után, main-re rebase-elve történik; addig a next-ből kimaradsz.`
      + `${phantomNote}`,
  }
}

// --- "Miért dep?" — a dep-jelzés magyarázata ('i' billentyű) ---------------

/** Hány közös fájlt sorolunk fel, mielőtt "+N további"-ra váltunk. */
const DEP_FILES_SHOWN = 8

/**
 * A dep-jelzés MAGYARÁZATA egy sorra: mely fájlokban van metszet a dep-PR-ral.
 *
 * TISZTA függvény: a bemenete a `queue --json`-ból épült sor (buildRows), nincs
 * se process-hívás, se hálózat. A metszetet NEM itt számoljuk — azt a queue
 * jq-ja adja (depFiles), ugyanabban a passzban, ami a dep-számot is levezeti.
 * Ez szándékos: egy metszet-logika van, és a magyarázat nem divergálhat attól
 * a jelzéstől, amit magyaráz.
 *
 * A fájl-lista ISMERETLEN volta (dep van, depFiles üres) külön mező, nem
 * "nincs közös fájl": a queue dep-számítása FAIL-CLOSED, tehát adathiánynál is
 * jelent depet (nagy PR-nál a GitHub limitálja a files-listát). Ott az "üres
 * metszet" hamis mért ténynek látszana — ki kell mondani, hogy nem tudható.
 */
export function depExplanation(row, shown = DEP_FILES_SHOWN) {
  // A stacked sornak nem "dep"-je van, hanem TALAPZATA: a base-e a queue-ban
  // ül, a sorsa azon dől el. A dep-tengely ott nem értelmezett (a modell
  // dep-je is null), ezért külön mondat jár neki, nem a "nincs dep".
  if (row.stackedOn !== null && row.stackedOn !== undefined) {
    return {
      hasDep: false,
      dep: null,
      files: [],
      shown: [],
      more: 0,
      moreLabel: '',
      filesUnknown: false,
      summary: `#${row.number} stackelt PR — a talapzata a #${row.stackedOn}, a sorsa azon dől el. Nézd a #${row.stackedOn} sorát.`,
    }
  }
  if (!row.dep) {
    return {
      hasDep: false,
      dep: null,
      files: [],
      shown: [],
      more: 0,
      moreLabel: '',
      filesUnknown: false,
      summary: `#${row.number}: nincs dep — a queue-ban előtte álló nyitott PR-ok egyikével sincs fájl-metszete.`,
    }
  }
  const files = Array.isArray(row.depFiles) ? row.depFiles : []
  const filesUnknown = files.length === 0
  const head = files.slice(0, shown)
  const more = Math.max(0, files.length - head.length)
  return {
    hasDep: true,
    dep: row.dep,
    files,
    shown: head,
    more,
    moreLabel: more > 0 ? `… +${more} további` : '',
    filesUnknown,
    summary: filesUnknown
      // Fail-closed dep adathiánnyal: a függés ténye áll, a MIBEN nem.
      ? `#${row.number} a #${row.dep}-től függ, de a közös fájlok listája NEM tudható (a files-adat hiányzik — nagy PR-nál a GitHub limitálja). A függést fail-closed jelentjük.`
      : `#${row.number} a #${row.dep}-gyel közös: ${head.join(', ')}${more > 0 ? ` (+${more} további)` : ''}`,
  }
}

/**
 * `tuipr conflict <PR> --json` → diagnózis-objektum.
 *
 * A TUI NEM implementálja újra a merge-tree mérést: a subcommandot hívja. Ez
 * ugyanaz az elv, amiért a queue-modellt sem számoljuk itt újra — a duplikált
 * döntési lánc szülte azt az elcsúszást, amit a (b) csomag megszüntetett.
 *
 * A hiba DOBÓDIK, nem nyeljük el: egy néma üres diagnózis a hívót arra
 * vezetné, hogy nincs conflict.
 */
export function fetchDiagnosis(pr) {
  const res = spawnSync('bash', [NEXT_SH, 'conflict', String(pr), '--json'], { encoding: 'utf8' })
  const spawnErr = spawnFailure(res, 'bash')
  if (spawnErr) throw new Error(`a #${pr} diagnózisa nem kérhető le: ${spawnErr}`)
  if (res.status !== 0) {
    throw new Error(`conflict --json hiba (exit ${res.status}): ${(res.stderr || res.stdout || '').trim() || '(nincs kimenet)'}`)
  }
  return JSON.parse(res.stdout)
}

// --- Az 'i' (info) panel: gyors rész + PROGRESSZÍV, ABORTÁLHATÓ mérés -------
//
// MIÉRT EGY BILLENTYŰ. Korábban két panel volt: 'i' = "miért dep?" (azonnali, a
// queue-modellből) és 'c' = conflict-diagnózis (drága, `tuipr conflict`).
// A felhasználó szempontjából viszont EGY kérdés van — "mi van ezzel a PR-ral,
// és miért?" —, és neki kellett tudnia, melyik felét melyik gomb adja. A user
// döntése: "csinálja a mérést, csak ne tartson percekig; ha progresszíven tudsz
// megjeleníteni és abortálni is tudsz, azzal el is dőlt a kérdés."
//
// A KÖLTSÉG-ASZIMMETRIA nem tűnik el, csak nem a felhasználóra tolódik: a gyors
// rész AZONNAL kirendereldik (nulla várakozás), a drága rész pedig háttérben
// tölt be, élő status-sorral, Esc-cel megszakíthatóan. A 'd'/'r' (ingyen vs.
// token) aszimmetria ezzel szemben MEGMARAD két billentyűnek: ott a drága út
// KÜLSŐ hatással jár (tokent költ), tehát megerősítés-köteles. A mérés
// read-only és lokális — nincs mit megerősíteni, csak megszakítani.

/**
 * Egy `--progress` NDJSON sor esemény-objektummá.
 *
 * FAIL-CLOSED, két ponton:
 *   - a nem-JSON sor DOBÓDIK, nem skipeljük. A néma skip azt a képet adná, hogy
 *     a mérés halad, holott a mérő már összefüggéstelen kimenetet ad (pl. egy
 *     jövőbeli formátumváltás után) — a status-sor örökre "3/7"-en állna.
 *   - a `pr` mező KÖTELEZŐ. Erre épül a stale-eldobás: PR-szám nélkül az
 *     eseményt nem tudjuk sorhoz kötni, tehát a race-védelem elveszne, és egy
 *     másik PR mérése átcsúszhatna a kijelölt sorra.
 */
export function parseProgressEvent(line) {
  let ev
  try {
    ev = JSON.parse(line)
  } catch (error) {
    throw new Error(`a progress-esemény nem parse-olható JSON-ként: ${error.message} — nyers sor: ${line}`)
  }
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
    throw new Error(`a progress-esemény nem objektum: ${line}`)
  }
  if (typeof ev.event !== 'string' || ev.event === '') {
    throw new Error(`a progress-eseményből hiányzik az \`event\` kulcs: ${line}`)
  }
  if (typeof ev.pr !== 'number' || !Number.isFinite(ev.pr)) {
    throw new Error(`a progress-eseményből hiányzik a \`pr\` szám: ${line} — enélkül nem köthető a kijelölt sorhoz (race-védelem)`)
  }
  return ev
}

/** A mérés-állapot kezdete EGY PR-ra. A `pr` a stale-eldobás horgonya. */
export function progressInit(pr) {
  return { pr, running: true, done: 0, total: 0, diag: null, aborted: false, error: null }
}

/**
 * Egy esemény alkalmazása a mérés-állapotra. TISZTA: új objektumot ad.
 *
 * KÉT ELDOBÁSI SZABÁLY, mindkettő valódi hibaosztályt zár ki:
 *   1) STALE PR: az `ev.pr !== st.pr` eseményt eldobjuk. Élő race: a #911 mérése
 *      fut, a user a #905-re navigál, ott is indul mérés, és a #905 eredménye
 *      ELŐBB érkezik — a #911 paneljébe a #905 conflictjai kerülnének.
 *   2) ABORT UTÁN: az abortált mérésbe késve befutó `result` sem íródik be. A
 *      child kill-je ASZINKRON (a már kiírt sor a pipe-ban ülhet), tehát a
 *      "megszakítva 3/7"-et felülírhatná egy teljes diagnózis — a user mért
 *      tényként olvasná azt, amit épp megszakított.
 */
export function progressReducer(st, ev) {
  if (ev.pr !== st.pr) return st
  if (st.aborted) return st
  switch (ev.event) {
    case 'start':
      return { ...st, total: typeof ev.total === 'number' ? ev.total : st.total }
    case 'probe':
      return {
        ...st,
        done: typeof ev.done === 'number' ? ev.done : st.done,
        total: typeof ev.total === 'number' ? ev.total : st.total,
      }
    case 'result':
      // A `diagnosis` HIÁNYA nem "üres diagnózis": az a mérő szerződés-szegése.
      // Némán null diagnózist beírni azt a képet adná, hogy nincs conflict.
      if (ev.diagnosis === null || typeof ev.diagnosis !== 'object') {
        return { ...st, running: false, error: 'a mérő `result` eseménye diagnózis nélkül jött — a kimeneti szerződés megsérült' }
      }
      return { ...st, running: false, diag: ev.diagnosis }
    case 'error':
      // HIBÁBÓL SOSEM LESZ DIAGNÓZIS: a diag marad null, és a hiba látszik.
      return { ...st, running: false, diag: null, error: String(ev.message ?? 'ismeretlen mérési hiba') }
    default:
      // Ismeretlen esemény-típus: NEM dobunk (egy újabb mérő-verzió adhat plusz
      // eseményt), de nem is értelmezzük — az állapot változatlan.
      return st
  }
}

/** A mérés megszakítása. A RÉSZeredmény (done/total) megmarad — lásd progressLabel. */
export function progressAbort(st) {
  if (!st.running) return st
  return { ...st, running: false, aborted: true }
}

/**
 * Egy mérés-esemény alkalmazása az INFO-PANEL state-jére — a PANEL-SZINTŰ
 * stale-védelem. TISZTA: stale eseményre a KAPOTT state-et adja vissza
 * (referencia-azonos), így a React setState no-op marad.
 *
 * MIÉRT KELL a progressReducer MELLETT: a reducer az `ev.pr !== st.pr`-t zárja
 * ki, azaz hogy egy mérésbe MÁS PR eseménye kerüljön. Az itteni ellenőrzés más
 * hibaosztály: a user közben MÁS sorra nyitott panelt (j/k), a régi mérés
 * callbackje pedig az ÚJ panel state-jébe írna. A `pr` a mérés indításakori
 * sor-szám; ha az már nem a panel sora, az esemény eldobandó — különben a user
 * egy MÁS PR mért conflict-tényét (vagy mérési hibáját) olvasná a friss
 * panelben.
 *
 * A `null` info (közben zárt panel) és a `progress: null` (nem-mérhető, stacked
 * sor) szintén változatlanul megy vissza: zárt/nem-mérő panel nem éled újra.
 */
export function applyProgressToInfo(cur, pr, ev) {
  if (!cur || cur.row.number !== pr || !cur.progress) return cur
  return { ...cur, progress: progressReducer(cur.progress, ev) }
}

/** A status-sor a mérés-állapotból. MÉRT számokat mond, nem becsül. */
export function progressLabel(st) {
  if (!st) return ''
  if (st.error) return `mérési hiba: ${st.error}`
  if (st.aborted) {
    // A NEVEZŐT csak akkor írjuk ki, ha MÉRTÜK (megjött a `start` esemény).
    // Előtte a "0/0 jelöltnél" mért ténynek olvasható ("nulla jelölt volt"),
    // holott a jelölt-számot még nem tudtuk — élő renderben ezt kimértük egy
    // 80 ms-nál abortált mérésen.
    return st.total > 0
      ? `mérés megszakítva ${st.done}/${st.total} jelöltnél`
      : 'mérés megszakítva (még a jelölt-lista előtt)'
  }
  if (st.running) {
    // A total 0 addig, amíg a `start` esemény meg nem jött — ilyenkor a nevezőt
    // NEM találgatjuk ("3/?"), mert egy hamis nevező hamis haladást sugall.
    return st.total > 0 ? `mérés: ${st.done}/${st.total} jelölt…` : 'mérés indul…'
  }
  if (st.diag) return `mérés kész (${st.diag.probed ?? st.done} jelölt megmérve)`
  return ''
}

/**
 * Az info-panel modellje: a GYORS rész (azonnal) + a LASSÚ rész (progresszív).
 *
 * A kettéosztás a KÖLTSÉG szerint van, nem téma szerint: minden, ami a
 * queue-modellben MÁR OTT VAN (dep-metszet, mergeMethod, landolás-blokkolók,
 * stacked-info) a `fast`-ba kerül és nulla várakozással renderelődik; ami MÉRÉST
 * igényel (merge-tree próbák), az a `slow`-ba, és csak akkor jelenik meg, ha
 * megérkezett. A `slow.state` teszi ezt gépileg olvashatóvá:
 *   idle | measuring | done | aborted | error
 *
 * A `measurable` azt mondja meg, van-e egyáltalán mit mérni. A STACKED sor nem
 * mérhető: a sorsa a talapzatán dől el, és a hozzá mért próba a talapzat
 * conflictjait mutatná a sajátjaként (ezt a bash oldal is külön ágon zárja ki).
 */
export function buildInfoModel({ row, progress = null }) {
  const dep = depExplanation(row)
  const stacked = row.stackedOn !== null && row.stackedOn !== undefined
  const fast = {
    dep,
    state: row.state,
    mergeMethod: row.mergeMethod ?? null,
    // A BRANCH-NÉV a modellből, NYERSEN. A csonkolás a nézeté (ott ismert a
    // keret belső szélessége), de a névnek a MODELLBŐL kell jönnie, hogy a
    // render ne a soron tapogasson — a `headRefName` a metódus forrása, tehát
    // ugyanabból a rekordból kell származnia, mint a `mergeMethod`, különben a
    // kettő elcsúszhatna (pl. egy részleges frissítésnél).
    headRefName: typeof row.headRefName === 'string' ? row.headRefName : '',
    stackedOn: stacked ? row.stackedOn : null,
    // A landolás-blokkolók ugyanabból a tiszta függvényből jönnek, amit a merge
    // megerősítő ekrány használ — egy szabály, két megjelenítés.
    landableBlockers: canMergeRow(row) ? [] : mergeBlockers(row),
    // A PROVIDER JELZÉSE, ÁTVEZETVE: a `classification` csak a MÉRŐ providerben
    // létezik (a gh/git provider szándékosan nem tölti). A nézet ezen dönti el,
    // hogy megjelenítheti-e az integrációs branch rebuild-állapotát — enélkül
    // a MÉRT és a KÖVETKEZTETETT tudás mosódna össze.
    classification: row.classification ?? null,
  }
  const measurable = !stacked
  let slow = { state: 'idle', diag: null, advice: null, label: '', error: null }
  if (progress) {
    if (progress.error) {
      slow = { state: 'error', diag: null, advice: null, label: progressLabel(progress), error: progress.error }
    } else if (progress.aborted) {
      // ABORTÁLT MÉRÉSBŐL NEM ÁLLÍTUNK CONFLICT-TÉNYT: a diag null marad, csak
      // a részeredmény ("3/7") látszik. A félbehagyott próba-sorozat nem
      // bizonyít se conflictot, se annak hiányát.
      slow = { state: 'aborted', diag: null, advice: null, label: progressLabel(progress), error: null }
    } else if (progress.diag) {
      slow = {
        state: 'done',
        diag: progress.diag,
        // Az ajánlás a MÉRT diagnózisból LEVEZETETT — ugyanaz a tiszta függvény,
        // amit a régi 'c' panel használt. A mérés-út változott, a döntés nem.
        advice: conflictAdvice(progress.diag),
        label: progressLabel(progress),
        error: null,
      }
    } else if (progress.running) {
      slow = { state: 'measuring', diag: null, advice: null, label: progressLabel(progress), error: null }
    }
  }
  return { row, measurable, fast, slow }
}

/**
 * A mérés elindítása STREAMKÉNT: `tuipr conflict <PR> --progress`.
 *
 * MIÉRT spawn (aszinkron) és nem spawnSync: a spawnSync a mérés teljes idejére
 * MEGFAGYASZTJA az Ink render-loopját — se navigálni, se kilépni nem lehetne, és
 * épp ez volt a régi 'c' panel baja (a #911-en 7 jelölt, másodpercek). Az
 * aszinkron út mellett a UI végig használható marad.
 *
 * A `spawn` INJEKTÁLHATÓ (opts.spawn): így a stream-kezelés — a soronkénti
 * pufferelés, a kill, az exit- és ENOENT-ág — unit-tesztelhető valódi
 * gyerekfolyamat nélkül.
 *
 * A HIBAÁGAK KÜLÖNVÁLNAK, mert más diagnózist érdemelnek:
 *   - nem-nulla exit `result` NÉLKÜL → a mérő elesett (a stderr-t átadjuk),
 *   - `error` esemény ENOENT-tel → a bash/script maga nem található. Ezt a
 *     `res.error?.code`-dal kell szétválasztani; exit-kódként "null"-nak
 *     látszana, és hamis "a mérés üresen tért vissza" diagnózist adna.
 *
 * AZ ABORT UTÁN NINCS TÖBB ESEMÉNY (mért race, BLOCKER volt): a `child.kill()`
 * ASZINKRON, és a Node a stdout `data` eseményt a kill UTÁN is kiadja a pipe-ban
 * MÁR BENNE LÉVŐ bájtokra (0/5/20/100 ms késleltetésnél mérve mind). Így a
 * félbehagyott próba-sorozat `result`-ja MÉGIS megjött, és aki nem szűrte, mért
 * ténynek vette: a lista `✓` KÉSZ-jelzőt adott egy le sem mért PR-ra, és az `i`
 * újranyitása a cache-ből szolgálta ki a "nincs conflict" képet.
 *
 * A GUARD EZÉRT ITT VAN, A FORRÁSNÁL, nem a fogyasztóknál: a panel-oldal
 * (`progressReducer`: `if (st.aborted) return st`) eddig is védett volt, a
 * cache-írás NEM — ugyanarról a mérésről a két réteg MÁST állított. Egy
 * forrás-oldali elnyomással minden fogyasztó egyszerre javul, és nem kell minden
 * új hívási helyen megismételni a szűrést (a hiányzó ismétlés volt a bug).
 */
export function startProgressDiagnosis(pr, { onEvent, onExit, spawn: spawnImpl = spawn } = {}) {
  const child = spawnImpl('bash', [NEXT_SH, 'conflict', String(pr), '--progress'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let buf = ''
  let stderr = ''
  let sawResult = false
  let finished = false
  let aborted = false

  const finish = (info) => {
    if (finished) return
    finished = true
    onExit?.(info)
  }

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    // ABORT UTÁN NÉMA: a megszakított mérés kimenete nem tény. A puffert sem
    // növeljük tovább — a félbehagyott stream maradékát nincs kinek átadni.
    if (aborted) return
    buf += chunk
    // SORONKÉNTI parse: a fél sor NEM parse-olható (JSON-hiba lenne), tehát a
    // maradékot a pufferben tartjuk a következő chunkig. A pipe chunk-határa
    // bárhol lehet — élőben a `result` (nagy objektum) rendszeresen kettévágódik.
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line === '') continue
      let ev
      try {
        ev = parseProgressEvent(line)
      } catch (error) {
        // A parse-hiba HANGOS: a stream szerződése sérült, tehát a mérés
        // eredménye nem tudható. Némán skipelve a status-sor örökre állna.
        finish({ error: error.message })
        child.kill?.()
        return
      }
      if (ev.event === 'result') sawResult = true
      onEvent?.(ev)
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => { stderr += chunk })

  child.on('error', (error) => {
    // ENOENT külön: a "bash nem található" NEM ugyanaz, mint egy elhasalt mérés.
    finish({
      error: error?.code === 'ENOENT'
        ? `a mérő nem indítható (ENOENT): a bash vagy a ${NEXT_SH} nem található`
        : `a mérő nem indítható: ${error?.message ?? String(error)}`,
    })
  })
  child.on('close', (code) => {
    if (aborted) { finish({ aborted: true }); return }
    if (code === 0 && sawResult) { finish({ ok: true }); return }
    // NEM-NULLA exit VAGY result nélküli 0: mindkettő hiba. A "0 exit, de nincs
    // result" azért is az, mert a hívó ilyenkor üres panelt kapna, és
    // "nincs conflict"-ként olvasná.
    finish({
      error: code === 0
        ? 'a mérő 0-val tért vissza, de nem adott `result` eseményt — a kimenet csonka'
        : `a mérő elesett (exit ${code}): ${stderr.trim() || 'nincs stderr'}`,
    })
  })

  return {
    /**
     * Megszakítás: a childot KILL-eljük, hogy ne maradjon zombie merge-tree
     * próba a háttérben. A már beérkezett részeredményt a hívó
     * progressAbort-tal jelöli — az ide késve befutó `result`-ot a reducer
     * eldobja (lásd az abort-szabályt ott).
     */
    abort() {
      aborted = true
      child.kill?.('SIGTERM')
    },
  }
}
