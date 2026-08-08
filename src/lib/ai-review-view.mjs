// tuipr — AI-REVIEW-VIEW: az AI-review LÁTHATÓSÁGA.
//
// Ami itt lakik: az eltelt-idő formázó, a progressz-címke, a HÉT végállapot
// leképezése, az `r` életciklus-kulcs és címke, valamint a panel AI-szekciójának
// sorai.
//
// KÜLÖN A RUN-TÓL, mert ez TISZTA FORMÁZÁS (a tesztek is így fedik): a
// végrehajtás mellékhatásos, a megjelenítés nem. A run IMPORTÁLJA innen az
// AI_REVIEW_TIMEOUT_MS-t (a watchdoghoz) — az irány EGYIRÁNYÚ, a view SEMMIT nem
// kér a runtól (mérve).
//
// RÉTEGREND: lefelé importál (layout: a panel-sorok CELLÁBAN mért tördelése).
import { clampCells, wrapCells } from './layout.mjs'
import process from 'node:process'

// === A HÁTTÉR-REVIEW LÁTHATÓSÁGA ==========================================
//
// A USER JELENTÉSE (#904), szó szerint: "a 904-esre indítottam review-t, de ez
// egy pár soros változtatás, és 5 perc alatt se látok semmi feedbacket sehol,
// még a fenti üzenetet írja az app. […] Most néhány óra múlva ránéztem, és azt
// írja, »megszakítva«. Ez így nem túl jó élmény."
//
// A DIAGNÓZIS HÁROM, EGYMÁSTÓL FÜGGETLEN HIBÁT talált — és a "megszakítva" NEM
// az volt, aminek látszott:
//
//  1. A `done` promise ÖRÖKRE PENDING maradt (lásd a `startAgentReview` close-
//     ágának kommentjét). A `showError` tehát SOSEM futott le, a status-sor pedig
//     örökre "az AI-review a HÁTTÉRBEN fut"-on állt. Ez a "5 perc alatt semmi
//     feedback" gyökere.
//  2. NEM VOLT PROGRESSZ: a statikus status kiíródott, és onnantól semmi. A
//     `--output-format json` mérve EGY nagy JSON-t ad a VÉGÉN (stdout közben
//     ÜRES), tehát streamelni nem is volt mit.
//  3. A VÉGÁLLAPOTOK ÖSSZEMOSÓDTAK: egyetlen `if (outcome.aborted)` ág írta a
//     "megszakítva"-t, ami HAZUG minden olyan esetben, amit nem a user váltott ki.
//
// A MÉRT IDŐK (mobile `claude-code-review.yml`, n=76 sikeres run, két beragadt
// outlier kiszűrve): p50 = 440 s (7:20), p75 = 619 s, p90 = 1037 s (17:17),
// p95 = 1186 s, max = 1866 s (31:06). A user 5 perces várakozása tehát a MEDIÁN
// ALATT volt: a feature nem lassú — a VISSZAJELZÉS hiányzott. Ezért a jelzés
// KIMONDJA a tipikus időt: a "2:14 / tipikus 7:20" pár önmagában megnyugtat.

/**
 * A HÁTTÉR-REVIEW PLAFONJA. A MÉRT maximum (31:06) közelében: a legitim hosszú
 * review-kat NEM vágja el, a végtelen lógást igen.
 *
 * MIÉRT SAJÁT WATCHDOG és nem CLI-flag: a `claude --help` (2.1.220) mérve NEM
 * ismer se `--timeout`-ot, se `--max-turns`-t. Ami van (`--max-budget-usd`), az
 * API-költésre való — a user viszont subscription-limitet fogyaszt, ott nincs mit
 * dollárban vágni. A plafon tehát a MI felelősségünk.
 */
export const AI_REVIEW_TIMEOUT_MS = Number(process.env.TUIPR_NEXT_AI_REVIEW_TIMEOUT_MS) > 0
  ? Number(process.env.TUIPR_NEXT_AI_REVIEW_TIMEOUT_MS)
  : 1_800_000

/**
 * A TIPIKUS (p50) idő — MÉRT, nem becsült. EZT MUTATJUK a usernek: az eltelt idő
 * önmagában nem információ ("2:14" — sok? kevés?), a tipikushoz mérve az.
 */
export const AI_REVIEW_TYPICAL_MS = 440_000

/** A p90 — e fölött a jelzés már FIGYELMEZTET, nem megnyugtat. */
export const AI_REVIEW_P90_MS = 1_037_000

/**
 * A "hosszú futás" küszöbe: eddig számolunk, utána a hangnem is változik
 * ("még fut, ez normális nagy PR-nál"). A user 2 percnél már bizonytalan volt.
 */
export const AI_REVIEW_LONG_MS = 120_000

/**
 * Az ELTELT IDŐ `m:ss` alakban.
 *
 * MIÉRT NEM `134s`: a perc-érzet a döntéshez kell (a tipikus 7:20-hoz mérve),
 * és a másodperc-szám azt nem adja meg. A másodperc NULLÁVAL FELTÖLTÖTT: a `2:4`
 * félreolvasható, és a sor szélessége ugrálna minden ticknél.
 *
 * FAIL-CLOSED: egy negatív vagy nem-szám bemenet DOB. Egy `-1:-1` alak a
 * status-sorban némán hazudna a mérésről — pontosan az az osztály, amit a
 * feature máshol mindenhol tilt.
 */
export function formatElapsed(ms) {
  // A TÍPUS-ELLENŐRZÉS SZIGORÚ, NEM `Number()`-KONVERZIÓ. MÉRT CSAPDA:
  // `Number(null) === 0` és `Number('') === 0`, tehát egy hiányzó mérés NÉMÁN
  // "0:00"-t adna — a status-sor azt mutatná, hogy a review épp most indult,
  // miközben nincs is mérés. Pontosan az a néma hazugság, amit a feature tilt.
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    throw new Error(`az eltelt idő nem MÉRT érték: ${JSON.stringify(ms)}`)
  }
  const n = ms
  const total = Math.floor(n / 1000)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

/**
 * A FUTÓ háttér-review status-sora — a "él-e még?" kérdés válasza.
 *
 * A HÁROM INFORMÁCIÓ, a hasznosság sorrendjében:
 *  1. ELTELT IDŐ + TIPIKUS IDŐ — ez egyedül megválaszolja a user kérdését;
 *  2. FINDING-SZÁM — a VALÓDI progressz ("3 finding beírva"), a hunk-session
 *     periodikus olvasásából (MÉRT költség: 0.42 s/hívás élő TUI mellett);
 *  3. TOOL-JELZÉS — a `stream-json` `tool_use` blokkjaiból (MÉRT: a stream
 *     azonnal ad `system/init`-et, majd per-message tool_use-t).
 *
 * A MEGSZAKÍTÁSI ÚT MINDIG BENNE VAN: a user 5 percig nem tudta, leállíthatja-e.
 */
export function aiReviewProgressLabel({ pr, elapsedMs, findings = 0, tool = null, xArmed = false }) {
  const elapsed = formatElapsed(elapsedMs)
  // A "HÁTTÉRBEN" SZÓ BENNE MARAD: ez a jelzés VÁLTJA FEL a régi statikus
  // status-sort, tehát ugyanazt a szerződést kell vinnie — a user innen tudja,
  // hogy a TUI HASZNÁLHATÓ marad (navigálhat, panelt zárhat), miközben a review
  // fut. A régi teszt (`a háttér-review ALATT a TUI RESZPONZÍV marad`) épp ezt
  // a szót őrzi, és jogosan: enélkül a jelzés úgy olvasható, mint egy blokkoló
  // művelet progressze.
  const parts = [`#${pr}: AI-review a HÁTTÉRBEN — ${elapsed}`]
  // A TIPIKUS IDŐ a HORGONY: enélkül az eltelt idő puszta szám.
  if (elapsedMs >= AI_REVIEW_P90_MS) {
    // A p90 FÖLÖTT figyelmeztetünk: itt már tényleg hosszabb a szokásosnál.
    parts.push(`a szokásosnál hosszabb (p90: ${formatElapsed(AI_REVIEW_P90_MS)})`)
  } else if (elapsedMs >= AI_REVIEW_LONG_MS) {
    // 2 PERC FÖLÖTT MEGNYUGTATUNK. A user kifogása épp az volt, hogy 5 perc után
    // sem tudta, baj-e — a tipikus 7:20 mellett nem volt.
    parts.push(`még fut, nagy PR-nál ez normális (tipikus: ${formatElapsed(AI_REVIEW_TYPICAL_MS)})`)
  } else {
    parts.push(`tipikus: ${formatElapsed(AI_REVIEW_TYPICAL_MS)}`)
  }
  // A FINDING-SZÁM a VALÓDI progressz — de csak ha van mit mondani (a "0 finding
  // beírva" az első másodpercben zaj lenne).
  if (Number(findings) > 0) parts.push(`${Number(findings)} finding beírva`)
  if (tool) parts.push(String(tool))
  // A MEGSZAKÍTÁS billentyűje LÁTHATÓ, a jelzés VÉGÉN. A DUPLA-X megerősítés
  // (a user kérése, szó szerint): az első `x` után a címke "megszakítás
  // megerősítése"-re vált — a második `x` hajt végre, bármely más gomb visszavon.
  parts.push(xArmed ? 'x: megszakítás megerősítése' : 'x: megszakítás')
  return parts.join(' · ')
}

/**
 * A HÁTTÉR-REVIEW VÉGÁLLAPOTAI — HÉT ÁG, MINDEGYIK SAJÁT üzenettel.
 *
 * EZ A JAVÍTÁS LÉNYEGE. A régi kód EGYETLEN ágat ismert:
 *   `if (outcome.aborted) setStatus('az AI-review megszakítva')`
 * — és a user ezt látta órák múlva egy permission-megtagadásba futott review
 * után. A "megszakítva" azt ÁLLÍTJA, hogy a USER döntött; ha nem ő döntött, ez
 * hazug jelzés, és a legrosszabb fajta: elviszi a valódi ok (és a javítás) elől.
 *
 * A HÉT ÁG NEM STÍLUS-KÉRDÉS: mindegyik MÁS TEENDŐT ír elő a usernek.
 *   `done`           → nézd át a findingokat (`d` nyitja meg), majd `f`
 *   `done-answer`    → a hunk nem élt: a findingok a VÁLASZBÓL eltárolva —
 *                      a `d` betölti őket (a hibrid (c) ág)
 *   `no-findings`    → nincs teendő, de tudd, hogy LEFUTOTT (nem hiba)
 *   `aborted`        → te szakítottad meg; `r` újraindít
 *   `timeout`        → a plafon lejárt; emeld a plafont vagy szűkítsd a PR-t
 *   `failed`         → a claude elhasalt; a stderr mondja, mit
 *   `killed-by-exit` → a TUI bezárása ölte meg; NE zárd be, amíg fut
 *
 * FAIL-CLOSED: ismeretlen `kind`-re DOB. Egy néma default szöveg pontosan a régi
 * gyűjtőág visszacsempészése lenne, csak most rejtve.
 */
export function aiReviewOutcome(o) {
  const pr = o?.pr
  switch (o?.kind) {
    case 'done': {
      const meta = [o.reviewPath, o.model ?? '?', o.costUsd === undefined || o.costUsd === null ? '$?' : `$${o.costUsd}`]
        .filter((x) => x !== undefined && x !== null)
        .join(', ')
      return {
        kind: 'done',
        isError: false,
        message:
          `#${pr}: ${o.added} AI-finding a hunk sessionbe írva (${meta}). `
          + "Nézd át őket ('d'), töröld a rosszakat, majd 'f' a feltöltéshez.",
      }
    }
    case 'done-answer': {
      // A HIBRID (c) ág: a hunk-session nem élt (vagy megszűnt), de a findingok
      // a review VÁLASZÁBÓL eltárolódtak. A "futtasd újra" típusú üzenet itt
      // TILOS: a költés megtörtént, és a válasz-JSON pontosan azért van, hogy
      // ne kelljen újrakölteni — a következő lépés a BETÖLTÉS, nem a review.
      const meta = [o.reviewPath, o.model ?? '?', o.costUsd === undefined || o.costUsd === null ? '$?' : `$${o.costUsd}`]
        .filter((x) => x !== undefined && x !== null)
        .join(', ')
      return {
        kind: 'done-answer',
        isError: false,
        message:
          `#${pr}: ${o.added} AI-finding a review válaszából ELTÁROLVA (${meta}) — a hunk-session `
          + 'nem élt a futás alatt, de a findingok NEM vesztek el. '
          + 'Az `r` a PR-panelen megnyitja a hunkban és betölti őket.',
      }
    }
    case 'no-findings':
      // NEM HIBA-OVERLAY: a gate dobása korábban "AI-review hiba"-ként mutatta,
      // holott a leggyakoribb ok az, hogy tényleg nincs mit jelenteni. A
      // hangnem viszont NEM megnyugtató sem: a mért csapda szerint egy le sem
      // futott review is adhat 0 findingot, tehát a usernek tudnia kell, hogy
      // az `r` újrafuttatás legitim válasz.
      return {
        kind: 'no-findings',
        isError: false,
        message:
          `#${pr}: az AI-review LEFUTOTT, de egyetlen findingot sem írt be `
          + `(${o.before ?? 0} volt, ${o.after ?? 0} van). Ez lehet jó hír (nincs defekt), `
          + "de a sikeres burkoló ezt nem bizonyítja — ha kételkedsz, 'r' újraindítja.",
      }
    case 'aborted':
      // CSAK a VALÓDI user-megszakításra. Az `x` (a status-soron hirdetett út).
      return {
        kind: 'aborted',
        isError: false,
        message:
          `#${pr}: te szakítottad meg az AI-review-t ('x') — a hunk sessionbe addig beírt `
          + "findingok MEGMARADTAK ('d' megnyitja őket). Az 'r' újraindítja a review-t.",
      }
    case 'timeout':
      return {
        kind: 'timeout',
        isError: false,
        message:
          `#${pr}: az AI-review IDŐTÚLLÉPÉSSEL leállt (${formatElapsed(o.timeoutMs ?? AI_REVIEW_TIMEOUT_MS)} `
          + `plafon; a mért tipikus ${formatElapsed(AI_REVIEW_TYPICAL_MS)}, a leghosszabb mért 31:06). `
          + 'A már beírt findingok megmaradtak. Mit tegyél: nézd meg őket a `d`-vel, és ha a PR '
          + 'tényleg nagy, emeld a plafont (`TUIPR_NEXT_AI_REVIEW_TIMEOUT_MS`) vagy indítsd újra `r`-rel.',
      }
    case 'failed': {
      // A STDERR ELSŐ SORA: a status-sor EGYSOROS, és a többsoros stack a
      // lényeget elnyomná. A teljes szöveg a hiba-overlayben él.
      const first = String(o.stderr ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '')[0] ?? '(nincs stderr)'
      // A SZIGNÁLLAL MEGÖLT PROCESSZ SAJÁT ÁG — a #904-es hibaosztály MARADVÁNYA.
      //
      // MÉRT TÉNY: ha a `claude`-ot NEM mi öljük meg (OOM-killer, `pkill`, a gép
      // elalvása, a shell SIGHUP-ja), a Node `close` eseménye `code === null`-t
      // ad — a kilépés SZIGNÁLLAL történt, nem kóddal. Izoláltan mérve a
      // `parseAgentReviewEnvelope` `status !== 0` ága elkapja, `exitCode: null`-lal.
      //
      // A HAZUGSÁG, amit ez leváltja: az `o.exitCode ?? '?'` a `null`-t `'?'`-re
      // fordította, a stderr pedig üres, tehát a user EZT látta:
      //   "az AI-review ELHASALT (exit ?): (nincs stderr)"
      // Ugyanaz a kár, mint a régi "megszakítva"-nál: a szöveg nem mondja meg,
      // MI történt, nem mondja meg, hogy ez NEM a user hibája, és nem ad teendőt.
      // Egy ÓRÁKIG futó review után épp ez a legvalószínűbb valódi vég.
      if (o.exitCode === null || o.exitCode === undefined) {
        // A SZIGNÁL NEVE A DIAGNÓZIS, NEM DEKORÁCIÓ. A `close` MÁSODIK
        // argumentumából jön (a core `startAgentReview`-ja akasztja rá a hibára),
        // és HÁROM KÜLÖN teendőt jelöl:
        //   SIGKILL → OOM-killer vagy `kill -9`: a gép memóriája fogyott el, vagy
        //             valaki erőszakkal ölte meg. Ellenszer: kevesebb párhuzamos
        //             munka, vagy szűkebb PR.
        //   SIGTERM → RENDEZETT leállítás kérése (rendszer-shutdown, egy `pkill`,
        //             egy process-manager). Nem memória-ügy.
        //   SIGHUP  → a TERMINÁL bezárása / a session megszűnése.
        // A NÉV NÉLKÜLI ESET SEM HALLGAT: kimondjuk, hogy az okot NEM TUDJUK. A
        // becsületesség itt a lényeg — a régi "exit ?" épp azt a látszatot adta,
        // hogy tudunk valamit (egy kódot), holott nem.
        const sig = typeof o.signal === 'string' && o.signal.trim() !== '' ? o.signal.trim() : null
        const hint = sig === 'SIGKILL'
          ? ' A `SIGKILL` tipikusan az OOM-killer vagy egy `kill -9` — a gép memóriája fogyhatott el.'
          : sig === 'SIGTERM'
          ? ' A `SIGTERM` RENDEZETT leállítás kérése volt (rendszer-shutdown, `pkill`, process-manager).'
          : sig === 'SIGHUP'
          ? ' A `SIGHUP` a terminál/session megszűnése — a TUI-t futtató shell zárult be.'
          : ''
        return {
          kind: 'failed',
          isError: true,
          message:
            `#${pr}: az AI-review-t egy SZIGNÁL ölte meg kívülről `
            + (sig === null
              ? '(a processz nem exit-kóddal állt le, és a szignál nevét NEM TUDJUK — az okot '
                + 'tehát nem tudjuk megnevezni). '
              : `(\`${sig}\`, nem exit-kóddal állt le).${hint} `)
            + 'Ez lehet külső beavatkozás: a gép elaludt, az OOM-killer közbelépett, vagy valaki '
            + '`pkill`-elte a claude-ot — NEM a te hibád, és NEM is review-hiba.'
            + `${String(o.stderr ?? '').trim() === '' ? '' : ` stderr: ${first}`} `
            + 'A már beírt findingok megmaradtak (`d` megnyitja őket); az `r` újraindítja a review-t.',
        }
      }
      // A TOKEN-KÖLTÉS KIMONDVA — MINDKÉT IRÁNYBAN. A "nem költöttünk" nem
      // mellékes: az a megnyugtató információ, ami eldönti, hogy az újrapróba
      // ingyen van-e.
      const spend = Number(o.costUsd) > 0
        ? `tokent KÖLTÖTTÜNK: $${o.costUsd}`
        : 'tokent NEM költöttünk (vagy nem mérhető)'
      return {
        kind: 'failed',
        isError: true,
        message: `#${pr}: az AI-review ELHASALT (exit ${o.exitCode ?? '?'}): ${first} — ${spend}.`,
      }
    }
    case 'killed-by-exit':
      // A KILÉPÉS ölte meg. A user #904-es esetének legvalószínűbb valódi vége,
      // amit a régi "megszakítva" NEM mondott ki — és amit MOST a kilépés ELŐTT
      // is megkérdezünk (lásd az app kilépés-figyelmeztetését).
      return {
        kind: 'killed-by-exit',
        isError: false,
        message:
          `#${pr}: az AI-review-t a TUI BEZÁRÁSA szakította meg (a \`claude -p\` a hunk `
          + 'sessionbe ír, ezért nem hagyhatjuk futni a kilépés után). A már beírt findingok '
          + 'megmaradtak. Ha végig akarod futtatni, ne lépj ki, amíg fut.',
      }
    default:
      throw new Error(
        `ismeretlen AI-review végállapot: ${JSON.stringify(o?.kind)}. A néma default szöveg `
        + 'TILOS: pontosan az a gyűjtőág lenne, ami a #904-es hazug "megszakítva"-t adta.',
      )
  }
}

/**
 * AZ `r` ÉLETCIKLUS-ÁLLAPOTA egy PR-ra: 'idle' | 'running' | 'done'.
 *
 * A USER EXPLICIT KÉRÉSE (4. élő teszt): az `r` állapotfüggő kulcs —
 *   idle    → indítás (megerősítő panel, mint eddig);
 *   running → letiltva (a "már fut" hint marad), a lábléc dimmelt jelzést ad;
 *   done    → REVIEW MEGNYITÁSA (hunk + betöltés + --agent-notes).
 *
 * A 'done' KÉT forrásból jöhet: a session AI-review state-jéből (done /
 * done-answer), VAGY a cache-elt, még be nem töltött válasz-findingokból (a
 * state már másik PR-t szolgálhat — a cache PR-ra kulcsolt). ÚJRA-REVIEW-T a
 * 'done' állapot NEM enged: az újraindítás előfeltétele az explicit elvetés
 * (dupla-`x` → cacheDiscardAiFindings + a state törlése).
 *
 * A lezárt-de-eredménytelen végállapotok (no-findings / aborted / timeout /
 * killed-by-exit / failed) 'idle'-t adnak: ott az `r` legitim újraindítás.
 */
export function aiReviewLifecycle({ review = null, pr, pending = null } = {}) {
  const own = review && typeof review === 'object' && review.pr === pr ? review : null
  // (wf24/4) A MEGNYITÁS-FOLYAMAT SAJÁT ÉLETCIKLUS-ÁLLAPOT: az `opening` alatt
  // az `r` nem indít újat és nem nyit confirmot — a lábléc `betöltés…`-t
  // hirdet. A pending-ág ELŐTT áll, mert a betöltés alatt a pending még
  // applied=false, ami 'done'-t (megnyitás-ajánlatot) adna vissza.
  if (own && own.status === 'opening') return 'opening'
  if (own && (own.status === 'starting' || own.status === 'running')) return 'running'
  if (pending && pending.applied !== true && Array.isArray(pending.findings) && pending.findings.length > 0) {
    return 'done'
  }
  if (own && (own.status === 'done' || own.status === 'done-answer')) return 'done'
  return 'idle'
}

/**
 * Az `r` kulcs ÁLLAPOTFÜGGŐ lábléc-címkéje (a globális KEYS és a panelFooter
 * közös forrása — két külön szöveg ugyanarra a kulcsra elcsúszna).
 */
export function rKeyLabel({ lifecycle = 'idle', xArmed = false } = {}) {
  // (wf24/4) A MEGNYITÁS-FOLYAMAT A LÁBLÉCBEN IS LÁTSZIK: a leütés első
  // képkockáján a címke `betöltés…`-re vált, még a blokkoló spawnSync-ek előtt
  // — enélkül a user egy néma, "halott" panelt lát pár másodpercig.
  if (lifecycle === 'opening') return 'r: betöltés…'
  // (wf31/5) FUTÓ REVIEW ALATT AZ `r` SZEGMENS ELTŰNIK — a címke ÜRES.
  //
  // A USER LELETE, szó szerint: "review indítása után nem kell »r: review (már
  // fut)« legend, egyszerűen ne legyen ott a legend."
  //
  // A HIBAOSZTÁLY: egy hirdetett kulcs, ami CSAK azt mondja meg, hogy NEM
  // MŰKÖDIK, DEAD KEY — ugyanaz, amit a `modalHasChoices` zár ki a nyilas
  // választásnál ("egy hirdetett, de nem működő nyíl dead key"). A szűk
  // láblécben ráadásul HELYET is visz el a MŰKÖDŐ kulcsoktól: a `panelFooter`
  // 100 oszloposnál a `clampCells` határán áll, tehát a "már fut" felirat
  // ÁRÁN egy valódi akció szegmense esett le.
  //
  // A MEGSZAKÍTÁS NEM VESZETT EL: az `x`-et a PANEL PROGRESSZ-SORA hirdeti
  // (`aiReviewPanelLines` `running` ága) — ott, AHOL A VÁRAKOZÁS ZAJLIK. Ez a
  // modul kimondott elve ("az `x` a panel progressz-sorának VÉGÉN hirdetve van,
  // tehát a user pontosan ott látja"), és erősebb jelzés is: a lábléc egy
  // statikus sáv, a progressz-sor a figyelem középpontja. Ezért az `xArmed`
  // ágon SEM tér vissza a szegmens.
  //
  // AZ ÜRES STRING (és nem egy hiányzó visszatérés): a `rKeyLabel` a
  // lábléc-építők KÖZÖS forrása, a hívók pedig szegmens-listába illesztik. Az
  // üres címkét a BEILLESZTŐ szűri ki (`panelFooter`, `legendWithRLabel`) — így
  // a "mi látszik" szerződés EGY helyen dől el, és a lógó szeparátor (`· ·`)
  // gépileg kizárt.
  if (lifecycle === 'running') return ''
  if (lifecycle === 'done') {
    // (wf31/6) A KÉSZ ÁLLAPOT `r`-je MÁR NEM MEGNYITÓ — az ELVETÉST hirdeti.
    //
    // A USER LELETE: "érkezett review esetén ne az 'r' nyissa meg a review-t,
    // hanem a 'd'. hunk-ban úgyis el lehet rejteni a notes-okat, tehát sokkal
    // értelmesebb."
    //
    // MIÉRT AZ ELVETÉST HIRDETI, ÉS MIÉRT NEM HALLGAT EL TELJESEN (mint a
    // `running` ág): a `running` alatt az `x` a PANEL PROGRESSZ-SORÁN hirdetve
    // van, tehát a lábléc elhallgatása nem veszít információt. A `done`
    // állapotban viszont NINCS progressz-sor (a mérés lefutott), tehát az
    // elvetés kulcsának NINCS MÁSIK HIRDETŐJE — egy elhallgatott `x` itt azt
    // jelentené, hogy a user nem tudja, hogyan szabadulhat meg egy nem kívánt
    // review-tól.
    //
    // (wf31/12) EZ A SZEGMENS AZ ELVETÉS EGYETLEN HIRDETŐJE — és ez a
    // status-sor kivezetése óta LOAD-BEARING. A korábbi alak mellett létezett egy
    // második hirdető is: az `r` leütésére adott status-sor felsorolta a `d`-t és a
    // dupla-`x`-et. Azt a sort a user kivezette ("teljesen felesleges, nem kell
    // szájbarágni"), tehát ha ez a címke is elhallgatna, az elvetés kulcsa
    // SEHOL nem jelenne meg.
    //
    // MIÉRT NEM INDÍTHAT ÚJAT: a kifizetett, be nem töltött findingokat egy néma
    // újraindítás FELÜLÍRNÁ — a memória-cache-ben ÉS a lemezen is (a review-store
    // ugyanarra a PR-kulcsra ír). Ezért az új indítás előfeltétele VÁLTOZATLANUL
    // az explicit elvetés (dupla-`x`).
    //
    // (wf31/8) A KORÁBBI INDOKLÁS ITT "a cache csak a memóriában él"-t állított —
    // az a disk-cache (review-store) bevezetése ELŐTTI állapot volt, és a user
    // szúrta ki a belőle származó hazug kilépés-figyelmeztetésen. A VÉDENDŐ
    // INVARIÁNS VÁLTOZATLAN (a friction az újraindítás előtt), csak az OKA
    // pontos: nem elvesznek, hanem FELÜLÍRÓDNAK.
    //
    // (wf31/12) A CÍMKE A VALÓDI KULCSOT NEVEZI MEG: `x: review elvetése`, nem
    // `r: elvetés (x)`. A user kérése, és egy MÉRHETŐ félrevezetés javítása: az
    // elvetést az `x` végzi (dupla nyomásra), az `r` ezen az állapoton HANGOS
    // NO-OP. A régi alak tehát az `r`-t hirdette a szegmens ELEJÉN — a szem
    // odaugrik —, és az igazi kulcsot zárójelbe tette a végén. Az idióma is
    // egységes lett: minden más szegmens `<kulcs>: <művelet>` alakú
    // (`d: diff`, `a: approve`), ez volt az egyetlen `<rossz kulcs>: <művelet>
    // (<jó kulcs>)` kivétel.
    //
    // A SZÓREND `review elvetése`, nem `elvetés`: a szomszédos szegmensek is a
    // TÁRGYAT nevezik meg (`f: review feltöltése`), és a puszta „elvetés" nem
    // mondja meg, MIT vetünk el — a panelben egyszerre több elvethető dolog is
    // szóba jöhet (findingok, a mérés).
    return xArmed ? 'x: review elvetése — még egy x' : 'x: review elvetése'
  }
  // (1c) A NYUGALMI CÍMKE RÖVID: a user kérése. A lábléc a legszűkebb,
  // degradálódó felület — ott az "AI-" előtag nem különböztet meg semmit (a `d`
  // a diff-review, az `r` a másik), viszont a többi kulcs helyét veszi el. A
  // provenance-szövegek (panel-szekciók, attesztáció, hibák) MEGTARTJÁK az
  // "AI-review"-t: ott tényleg informatív, hogy mi költött tokent.
  return 'r: review'
}


// --- A PANEL AI-REVIEW SZEKCIÓJA (3) ----------------------------------------

/** Ennyi findingot mutat a panel rövid listája; a többi darabszámmal kimondva. */
export const AI_PANEL_FINDINGS_SHOWN = 5

/**
 * A SUMMARY SOR-PLAFONJA — FAIL-SOFT BIZTOSÍTÉK, NEM TERVEZETT KORLÁT.
 *
 * (wf31/50) A user kérdése: "a review summary-je most cappelve van 4 sorba […]
 * Érdemes cappelve tartani? Ez úgyis egy summary, megjelenhetne mind, nem?" —
 * és a válasz igen, mert az ELŐZŐ ÉRTÉK (4) A ROSSZ DOLGOT VÉDTE.
 *
 * A RÉGI INDOKLÁS az volt, hogy "a hosszú összegző nem tolhatja ki a
 * finding-listát". Ez PRIORITÁS-döntés volt, nem hely-kérdés: a fizikai korlátot
 * a `clipBodyLines` kezeli (a panel törzsét a terminál magasságához vágja, ÉS ki
 * is mondja: "… a panel csonkolva"). A 4-es cap tehát arról döntött, hogy szűk
 * helyen a summary vagy a findingok nyerjenek — és FORDÍTVA döntött, mint kell:
 *
 *   · a FINDINGOK máshol is elérhetők: a `d` megnyitja őket a hunkban, a kód
 *     mellett, TELJES egészében — a panel 5 elemű listája (`AI_PANEL_FINDINGS_SHOWN`)
 *     amúgy is csak ízelítő, a "… és N további" ki is mondja;
 *   · a SUMMARY viszont SEHOL MÁSHOL nincs meg. Ez a verdict — pontosan az, amit
 *     a user korábban hiányolt ("a findingok listája NEM verdict", wf24/2). Ha itt
 *     csonkolódik, elveszett.
 *
 * A rövidítés helye tehát a finding-lista, nem az összegző.
 *
 * MIÉRT MARAD MÉGIS PLAFON, ÉS MIÉRT ÉPP 12: nem a tervezett esetre, hanem az
 * ELSZALADT MODELL-VÁLASZRA. A prompt 2-4 mondatot kér, ami cellára tördelve 3-6
 * sor — egy 12-es plafon a NORMÁL esetet sosem érinti, egy 40 soros hallucinált
 * összegzőt viszont nem hagy a panelre ömleni. Ez védőháló, nem UI-döntés.
 *
 * A CSONKOLÁST A `…` TOVÁBBRA IS KIMONDJA — a néma levágás azt hitetné, hogy a
 * verdict ott véget ért.
 */
export const AI_PANEL_SUMMARY_LINES = 12

/**
 * A PR-panel AI-review szekciójának SOR-LEÍRÓI — az app render-fája ebből épül.
 *
 * MIÉRT A PANELBEN (a user szó szerint): "a statusüzenet a képernyő lenti
 * részén nem jó hely, mutálja a layoutot". A megerősítés, a progressz, a
 * végállapot, a finding-lista és a betöltés-ajánlat MIND a PR-panelben él; az
 * alsó globális status-sor AI-review vonatkozású használata megszűnt.
 *
 * TISZTA függvény: a `now` injektált, tehát a futó ág eltelt-idő-számítása
 * determinisztikusan tesztelhető. Minden sor display-CELLÁBAN clampelt.
 */
export function aiReviewPanelLines(review, { innerWidth = 80, now = Date.now() } = {}) {
  if (!review || typeof review !== 'object') return []
  const W = Math.max(1, Math.floor(Number(innerWidth) || 1))
  // A DEGRADÁLT review caveat-je minden végállapot-sor ELÉ kerül: a findingok
  // látszanak, de a "nem teljes" tényt nem szabad elhallgatni (attesztáció!).
  const caveatLine = review.caveat
    ? [{ key: 'ai-caveat', color: 'yellow', text: clampCells(`⚠ ${review.caveat}`, W) }]
    : []
  switch (review.status) {
    case 'starting':
      // AZ AZONNALI VISSZAJELZÉS (6): még a session-check és a git-fetch előtt.
      return [{ key: 'ai-0', color: 'cyan', text: clampCells('⏳ AI-review indul…', W) }]
    case 'opening':
      // (wf24/4) UGYANAZ A HIBAOSZTÁLY, MINT A 'starting'-nál: a kész review
      // `r`-je is blokkoló spawnSync-ekkel (repo-gyökér, session-azonosító,
      // PR-refek) indul, tehát a leütés után a UI némán állt — a user "még
      // mindig nem reszponzív" lelete. A jelzés a leütés ELSŐ képkockáján megy
      // ki, a blokkoló hívások ELŐTT.
      return [{ key: 'ai-0', color: 'cyan', text: clampCells('⏳ betöltés…', W) }]
    case 'running': {
      const label = aiReviewProgressLabel({
        pr: review.pr,
        elapsedMs: Math.max(0, now - (review.startedAt ?? now)),
        findings: review.findings ?? 0,
        tool: review.tool ?? null,
        // A DUPLA-X élesítése: az első `x` után a címke "megszakítás
        // megerősítése" — a jelzés OTT vált, ahol az `x`-et hirdetjük.
        xArmed: review.xArmed === true,
      })
      return [{ key: 'ai-0', color: 'cyan', text: clampCells(`⏳ ${label}`, W) }]
    }
    case 'done':
    case 'done-answer': {
      const out = []
      // A FEJLÉC FELÜLÍRHATÓ (`headNote`): a degradált utakon a hívó ŐSZINTE
      // fejlécet ad — élő session melletti ref-fetch-hibán (hazug-felirat-1)
      // vagy elhasalt hunk-írás-mérésen (dupla-betoltes-1) a default
      // "a hunk-session nem élt a futás alatt" HAMIS állítás lenne.
      //
      // (wf24/1) A DEFAULT FEJLÉC TÖMÖR. A user szó szerint: a
      // "… ELTÁROLVA — a hunk-session nem élt a futás alatt" VERBOSE ÉS
      // ÉRDEKTELEN — implementációs részlet, ami nem a usernek szól. Ami a
      // usernek szól: hány finding van, és mi a következő lépésük (a `done`
      // ágon MÁR a hunkban, a `done-answer` ágon betöltésre VÁRVA). A
      // degradált utak `headNote`-ja továbbra is FELÜLÍR — ott az ok
      // kimondása attesztáció, nem részlet.
      const head = typeof review.headNote === 'string' && review.headNote !== ''
        ? review.headNote
        : review.status === 'done'
        ? `✓ ${review.added} finding a hunkban`
        : `✓ ${review.added} finding (betöltésre vár)`
      out.push({ key: 'ai-0', color: 'green', text: clampCells(head, W) })
      out.push(...caveatLine)
      // (wf24/2) AZ ÖSSZEGZŐ A FINDINGOK FÖLÖTT. Ez az, amit a user hiányolt:
      // a findingok listája NEM verdict. Cellára tördelve, és (wf31/50 óta) CSAK
      // egy fail-soft plafonnal — a rövidítés helye a finding-lista, nem az
      // összegző; az indoklás az `AI_PANEL_SUMMARY_LINES` fejénél áll.
      const summaryText = typeof review.summary === 'string' ? review.summary.trim() : ''
      if (summaryText !== '') {
        const wrapped = wrapCells(summaryText, W)
        const shownSum = wrapped.slice(0, AI_PANEL_SUMMARY_LINES)
        if (wrapped.length > shownSum.length) {
          // A CSONKOLÁS KIMONDVA: a néma levágás azt hitetné, hogy a verdict
          // ott véget ért. A `…` a MÁR CLAMPELT sor végére kerül, ezért az
          // utolsó sort újraclampeljük a jelölővel együtt.
          const last = shownSum[shownSum.length - 1]
          shownSum[shownSum.length - 1] = clampCells(`${last} …`, W)
        }
        shownSum.forEach((t, i) => out.push({ key: `ai-sum${i}`, text: t }))
      }
      const findings = Array.isArray(review.findings) ? review.findings : []
      const shown = findings.slice(0, AI_PANEL_FINDINGS_SHOWN)
      shown.forEach((f, i) => {
        const pos = f.newLine !== undefined && f.newLine !== null
          ? `:${f.newLine}`
          : f.oldLine !== undefined && f.oldLine !== null ? `:-${f.oldLine}` : ''
        out.push({ key: `ai-f${i}`, dimColor: true, text: clampCells(`  · ${f.filePath}${pos} — ${f.summary}`, W) })
      })
      if (findings.length > shown.length) {
        out.push({ key: 'ai-more', dimColor: true, text: clampCells(`  … és ${findings.length - shown.length} további`, W) })
      }
      // (wf24/3) AZ AKCIÓ-AJÁNLAT SOR MEGSZŰNT. A user szó szerint: "operation
      // labelek a statussorban vannak. Modalba elég a state, hogy a review
      // kész." Az `r`/`x` kulcsokat a panel LÁBLÉCE hirdeti (rKeyLabel +
      // panelFooter), tehát ez a sor tiszta duplikáció volt.
      //
      // A `review.offer` FLAG MEGMARAD és VÁLTOZATLANUL VEZÉREL: az Enter/`r`
      // útja, az `x`-elvetés élesítése és a betöltés-teljesülés (`offer:false`)
      // mind ebből dönt — csak a KIÍRÁS tűnt el, a VISELKEDÉS nem.
      return out
    }
    case 'no-findings':
    case 'aborted':
    case 'timeout':
    case 'killed-by-exit':
      return wrapCells(String(review.message ?? ''), W).slice(0, 6)
        .map((t, i) => ({ key: `ai-${i}`, dimColor: true, text: t }))
    case 'failed':
      // A HIBA IS A PANELBEN él (nem a globális hiba-overlayen): az AI-review
      // minden állapota EGY helyen olvasható. Pirosan, tördelve, korlátozott
      // sor-számmal (a nyers stderr ne tolja ki a listát).
      return wrapCells(String(review.message ?? ''), W).slice(0, 12)
        .map((t, i) => ({ key: `ai-${i}`, color: 'red', text: t }))
    default:
      throw new Error(
        `ismeretlen AI-review panel-státusz: ${JSON.stringify(review.status)} — a néma default `
        + 'pontosan a #904-es gyűjtőág-osztály lenne.',
      )
  }
}
