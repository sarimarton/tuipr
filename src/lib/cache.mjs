// tuipr — CACHE: PR-számra kulcsolt, SESSION-idejű mérés-cache + lista-jelző
// + review-nyom könyvelés + az AI-findings slotok.
//
// TISZTA MODUL: NULLA projekt-import és NULLA I/O. Ez nem véletlen, hanem MÉRT
// invariáns — a test/next-cache.test.ts a fájl EGÉSZÉT olvassa, és megköveteli,
// hogy ne legyen benne se spawn, se fájl-I/O: a jelző-előállítók minden
// renderben lefutnak, tehát egy itt lapuló processz-indítás a listát lassítaná.
//
// (A teszt korábban a core.mjs-t a `// === CACHE` … `// === CACHE-VÉGE` markerek
// KÖZÖTT slice-olta. A fájl-per-szekció vágás után a modul MAGA a szekció —
// és ezzel eltűnt az a hibaosztály, ahol egy elmozdult marker NÉMÁN üres
// slice-ot ad, amin minden tiltó assertion "átmegy".)

// === CACHE: PR-számra kulcsolt, SESSION-idejű mérés-cache + lista-jelző ======
//
// A PROBLÉMA, amit megszüntet: az `i` panel újranyitása MINDEN alkalommal
// újrafuttatta a merge-tree próbákat (a #911-en 7 jelölt, másodpercek). A user
// ezt "zavaró"-nak nevezte, és joggal: ugyanarra a kérdésre ugyanaz a válasz —
// hacsak nem mozdult el az, amiből a válasz származik.
//
// AMIBŐL A VÁLASZ SZÁRMAZIK, az a HORGONY, és PONTOSAN KÉT dolog:
//   1) a PR `updatedAt`-je — új push/rebase/komment: a mért head már nem ez;
//   2) a trunk (`origin/<main|dev>`, lásd trunkBranch) SHA — a merge-tree próba
//      a trunk ELLEN mér, tehát a trunk elmozdulása az EREDMÉNYT változtatja
//      meg, a PR-t nem érintve.
// A kettő NEM helyettesíti egymást: egy PR-t nem érintő trunk-push a PR
// updatedAt-jét nem mozdítja, mégis érvényteleníti a diagnózist.
//
// MIÉRT NEM TÖRLÜNK, HANEM ELAVULTNAK JELÖLÜNK: a listán jelezni kell, hogy
// VAN mért eredmény, csak már nem érvényes. A törlés ("nincs mérés") és az
// elavulás ("volt, de a bázis elmozdult") MÁS teendőt jelent a usernek, és a
// cache-elt eredményt "kész"-nek mutatni a legdrágább hiba: a user a mért
// conflict-hiányra hivatkozva mergelne egy elmozdult bázisú PR-t.
//
// MIÉRT SESSION-IDEJŰ (nem lemezen): a next kép óránként mozog; egy
// perzisztens cache napokat élne túl, és a horgony-ellenőrzés minden induláskor
// gh/git hívást kívánna soronként — épp azt a lassulást hozná vissza, amiért a
// cache készült.
//
// (1d) EZ A DÖNTÉS A **MÉRÉS-CACHE**-RE (diagnosis) ÁLL, ÉS VÁLTOZATLAN. A
// REVIEW-EREDMÉNY azonban KÜLÖN, PERZISZTENS rétegbe került
// (bin/next/review-store.mjs), mert MÁS TERMÉSZETŰ ADAT: KIFIZETETT (tokent
// költött), és nem a queue ÁLLAPOTÁRÓL szól, hanem a PR DIFFJÉRŐL — tehát
// pontosan addig érvényes, ameddig a horgonya áll, nem "a session végéig". A
// fenti ellenérv sem áll rá: a lemez-olvasás EGYSZER fut (induláskor, kötegelten),
// nem soronként és nem renderenként, tehát a listát nem lassítja. A user kérése:
// "a review-kat cache-elje diszkre az app, mert fárasztó mindig újraindítani."
//
// A KÉT RÉTEG NEM MOSÓDIK ÖSSZE, és ez a fájl NULLA-I/O MARAD (lásd a fejlécet):
// a render-úton EZ a memória-cache áll; a lemez csak a TUI indulásakor és a
// review befejezésekor/elvetésekor mozdul.

/** A cache slotjai. A diagnózis és a review-report FÜGGETLENÜL avul. */
const CACHE_SLOTS = new Set(['diagnosis', 'reviewReport'])

/** A review-nyom elfogadott forrásai. */
const REVIEW_TRACE_SOURCES = new Set(['ai', 'hunk'])

/**
 * A NÉGYÁLLAPOTÚ lista-jelző glifjei.
 *
 * A SZÉLESSÉG MÉRVE (tmux 3.7b, CSI 6n cursor-advance, Ghostty-ban futó tmux):
 *   ⋯ U+22EF advance=1 · ✓ U+2713 advance=1 · ~ U+007E advance=1 · ⊙ U+2299 advance=1
 * Nem tippeltük meg: a user NÉGYSZER jelentette be az oszlop-csúszást, aminek
 * pontosan az a gyökere, hogy valaki egy glif szélességét megtippelte.
 *
 * A "kész" jel `✓` U+2713 (THIN check), NEM `✔` U+2714 — az U+2714 az
 * approve-oszlop `approved` jele (RMARKS). "Egy jelentés, egy glif": ha a kettő
 * egyezne, a szem az approve-jelet olvasná ott, ahol a MÉRÉS készültségéről van
 * szó, és a két oszlop összemosódna.
 *
 * A `none` állapotnak NINCS glifje: az a leggyakoribb sor-állapot, és egy üres
 * helyfoglaló minden soron csak zaj (plusz egy cella minden sorban, a
 * title-büdzsé kárára).
 */
export const CACHE_GLYPHS = {
  measuring: '⋯',
  fresh: '✓',
  stale: '~',
}

/**
 * A REVIEW-NYOM glifje. `⊙` U+2299 (CIRCLED DOT OPERATOR), MÉRVE 1 cella.
 *
 * MIÉRT nem a `●`/`○`: azok MÁR foglaltak (queue-tagság ill. approve-oszlop) —
 * "egy jelentés, egy glif".
 */
export const REVIEW_TRACE_GLYPH = '⊙'

/**
 * A cache tárolója. SESSION-idejű: egy TUI-példány élete.
 *
 * `entries`: `"<pr>:<slot>"` → bejegyzés. A LAPOS kulcs szándékos: egy
 * PR-onkénti al-Map beszúrási sorrendtől függő ürességi állapotokat ad
 * (üres al-Map vs. nem-létező), amit minden olvasónak kezelnie kellene.
 *
 * `reviewTrace`: PR-szám → forrás-halmaz. KÜLÖN a bejegyzésektől, mert MÁS a
 * természete: a nyom TÉNY a sessionről ("ezen a PR-on futott review"), nem
 * MÉRÉS — nem avul a main elmozdulásával, és az `R` sem törli.
 */
export function createCache() {
  // Az `aiFindings` a HIBRID réteg tárolója (PR-szám → { findings, applied }):
  // a review VÁLASZÁBÓL eltárolt findingok. KÜLÖN az `entries`-től, mert nem
  // mérés (nem avul a horgonnyal), és KÜLÖN a nyomtól, mert tartalma van —
  // lásd a cacheStoreAiFindings fejét.
  return { entries: new Map(), reviewTrace: new Map(), aiFindings: new Map() }
}

const slotKey = (pr, slot) => `${pr}:${slot}`

function assertSlot(slot) {
  if (!CACHE_SLOTS.has(slot)) {
    // HANGOS: egy elírt slot-név NÉMÁN sosem-találó cache-t adna (minden
    // megnyitás újramérne, és senki nem venné észre, hogy a cache halott).
    throw new Error(
      `ismeretlen cache-slot: ${JSON.stringify(slot)} — érvényes: ${[...CACHE_SLOTS].join(', ')}`,
    )
  }
}

/**
 * Az INVALIDÁLÁSI HORGONY egy sorra: a PR `updatedAt`-je + az `origin/main` SHA.
 *
 * FAIL-CLOSED az adathiányra: ha bármelyik fél hiányzik, az `unknown: true`
 * marker kerül rá, és az `anchorsEqual` SOSEM ad egyezést — még önmagával sem.
 * MIÉRT: ha a hiányzó `updatedAt`-et csendben `""`-re vinnénk, két KÜLÖNBÖZŐ
 * időpontban mért bejegyzés horgonya EGYEZNE, tehát egy elavult diagnózist
 * "friss"-nek mutatnánk. Inkább újramérünk, mint hogy hazudjunk a frissességről.
 */
export function cacheAnchor({ row, mainSha } = {}) {
  const updatedAt = typeof row?.updatedAt === 'string' && row.updatedAt !== '' ? row.updatedAt : null
  const sha = typeof mainSha === 'string' && mainSha !== '' ? mainSha : null
  const anchor = { updatedAt, mainSha: sha }
  if (updatedAt === null || sha === null) anchor.unknown = true
  return anchor
}

/** Két horgony egyezése. ISMERETLEN horgony SOSEM egyezik (fail-closed). */
export function anchorsEqual(a, b) {
  if (!a || !b) return false
  if (a.unknown === true || b.unknown === true) return false
  return a.updatedAt === b.updatedAt && a.mainSha === b.mainSha
}

/**
 * Egy MÉRÉS-INDÍTÁS bejegyzése. A `measuring` állapot ELŐBBRE való, mint a
 * stale: ha elindult az újramérés, a sor "mér…", nem "elavult" — a user épp azt
 * látja, ami történik.
 */
export function cacheMarkMeasuring(cache, pr, slot, { anchor } = {}) {
  assertSlot(slot)
  cache.entries.set(slotKey(pr, slot), { measuring: true, anchor: anchor ?? null, value: null, error: null, aborted: false })
  return cache
}

/**
 * Egy MÉRÉS-EREDMÉNY bejegyzése. Három kimenet, három ág:
 *   - `value`   — mért eredmény (ez az egyetlen, ami "kész"),
 *   - `error`   — a mérő elesett: NINCS érték, tehát NEM kész,
 *   - `aborted` — a user megszakította: részeredmény nem diagnózis.
 * A hibás/abortált bejegyzés is BEKERÜL (a `measuring` állapotot le kell
 * zárni), csak nem minősül késznek.
 */
export function cachePut(cache, pr, slot, { value = null, error = null, aborted = false, anchor } = {}) {
  assertSlot(slot)
  cache.entries.set(slotKey(pr, slot), {
    measuring: false,
    anchor: anchor ?? null,
    value,
    error,
    aborted,
  })
  return cache
}

/** Egy bejegyzés, vagy `null`. A hívó a `cacheEntryState`-tel dönt róla. */
export function cacheGet(cache, pr, slot) {
  assertSlot(slot)
  return cache.entries.get(slotKey(pr, slot)) ?? null
}

/**
 * A TELJES cache-invalidálás (`R`). A review-nyomot NEM törli: az nem MÉRÉS,
 * hanem tény a sessionről. Ha törölnénk, egy MEGTÖRTÉNT review után az
 * attesztáció a rövidebb ("nem volt review") body-ra esne vissza — az
 * attesztáció akkor hazudna, csak a másik irányba.
 */
export function cacheInvalidateAll(cache) {
  cache.entries.clear()
  return cache
}

/**
 * EGY bejegyzés állapota a MOSTANI horgonyhoz mérve:
 *   `none`      — nincs bejegyzés, vagy van, de nincs benne mért érték
 *                 (hiba / abortálás): nincs mit "késznek" mutatni;
 *   `measuring` — fut a mérés;
 *   `fresh`     — van érték, és a horgony EGYEZIK;
 *   `stale`     — van érték, de a horgony elmozdult (vagy nem tudható).
 */
export function cacheEntryState(entry, anchor) {
  if (!entry) return 'none'
  if (entry.measuring === true) return 'measuring'
  // A hibával/abortálással zárult mérésre "kész" pipát adni a legrosszabb
  // hazugság: nincs mért eredmény. Ezek `none`-ok, tehát a sor újramérhető.
  if (entry.error !== null && entry.error !== undefined) return 'none'
  if (entry.aborted === true) return 'none'
  if (entry.value === null || entry.value === undefined) return 'none'
  return anchorsEqual(entry.anchor, anchor) ? 'fresh' : 'stale'
}

/**
 * Egy PR állapota a listához. Default slot a `diagnosis` — a lista-jelző erről
 * a mérésről beszél (a review-reportnak külön jelzője van: a review-nyom).
 */
export function cacheState(cache, pr, anchor, slot = 'diagnosis') {
  return cacheEntryState(cacheGet(cache, pr, slot), anchor)
}

/**
 * REVIEW-NYOM jelölése: ezen a PR-on ebben a SESSIONBEN futott review.
 *
 * A KORLÁT KIMONDVA: a hunk-session REPO-szintű, nem PR-szintű (`hunk session
 * comment list --repo <root>`), tehát a "melyik PR-hoz tartozik egy komment"
 * információ a hunkból NEM kérdezhető le. Ezt MI tartjuk nyilván — és csak
 * arról tudunk, amit MI indítottunk. Egy előző sessionben (vagy a hunk CLI-ből
 * kézzel) írt komment NEM látszik nyomként. Ezt a docs/next.md kimondja: nem
 * tehetünk úgy, mintha tudnánk valamit, amit nem.
 */
export function markReviewTrace(cache, pr, source) {
  if (!REVIEW_TRACE_SOURCES.has(source)) {
    throw new Error(
      `ismeretlen review-nyom forrás: ${JSON.stringify(source)} — érvényes: ${[...REVIEW_TRACE_SOURCES].join(', ')}`,
    )
  }
  const set = cache.reviewTrace.get(pr) ?? new Set()
  set.add(source)
  cache.reviewTrace.set(pr, set)
  return cache
}

/** Van-e a SESSIONBEN indított review-nyom ezen a PR-on. */
export function hasReviewTrace(cache, pr) {
  return (cache.reviewTrace.get(pr)?.size ?? 0) > 0
}

/**
 * A NYOM FORRÁSAI ezen a PR-on, DETERMINISZTIKUS sorrendben.
 *
 * MIÉRT KELL a `hasReviewTrace` boolean-ja MELLETT: az attesztációs body
 * megnevezi a PROVENANCE-t ("claude -p AI-review" vs. "hunk inline review"), és
 * ez a szöveg a PR AUDIT-TRAILJÉBE megy fel. A nyers `Set` iterációs sorrendje a
 * BESZÚRÁS sorrendje, tehát ugyanaz a két nyom (ai + hunk) más sorrendben más
 * body-t adna — futásonként változó audit-szöveg, ok nélküli diff-zaj. A
 * REVIEW_TRACE_SOURCES deklarált sorrendjére szűrünk, ami fix.
 */
export function reviewTraceSources(cache, pr) {
  const set = cache?.reviewTrace?.get(pr)
  if (!set || set.size === 0) return []
  return [...REVIEW_TRACE_SOURCES].filter((s) => set.has(s))
}

/**
 * A cache-állapot LISTA-JELZŐJE — kompakt (1 cella) és DIMMELT.
 *
 * A DIMMELÉS a user 3. elve: "a sárga CSAK valódi figyelmeztetésre (költség,
 * blokkolók)". A cache-státusz metaadat a mérésről, nem figyelmeztetés — még az
 * elavult sem: az nem hibát jelent, hanem azt, hogy újra kell mérni.
 *
 * A `none` állapot `null`-t ad: nem paddolunk üresen.
 */
export function cacheIndicatorFlag(state) {
  const glyph = CACHE_GLYPHS[state]
  if (!glyph) return null
  return { label: glyph, color: 'gray' }
}

/**
 * A review-nyom LISTA-JELZŐJE. Nyom nélkül `null` (a default sor nem kap jelet).
 *
 * A SZÍN `whiteBright` — KÉT LÉPÉSBEN jutottunk ide, a user méréseiből: a `gray`
 * "alig látható" volt, a `cyan` pedig "lehet még élénkebb". A `gray` a
 * METAADAT-jelzők színe (cache-státusz, stacked, draft), és a review-nyom NEM
 * metaadat: azt mondja, hogy ezen a PR-on VAN mit megnézni, ami a lista
 * legcselekvésre-hívóbb információja.
 *
 * MIÉRT `whiteBright`, ÉS NEM `white`: a sima `white` a terminál DEFAULT
 * szövegszíne — egy default-színű jel nem "élénkebb", csak jelöletlen. A
 * `whiteBright` a fényes ANSI-variáns (chalk named color, az Ink `colorize`-ja
 * a `color in chalk` próbán átengedi), tehát a sor többi eleménél TÉNYLEGESEN
 * világosabb.
 *
 * A SZÍNES CSALÁDOK KI VANNAK ZÁRVA: a sárga a valódi figyelmeztetésé (a user 3.
 * elve: költség, blokkolók), a zöld az approve-oszlopé, a cyan a dep- és
 * approve-olhatod-jelzéseké — a fehér az EGYETLEN szabad, kiemelő érték.
 *
 * A GLIF VÁLTOZATLAN (`⊙`): egy tömörebb jel (pl. `◉` U+25C9) látványosabb lenne,
 * de a SZÉLESSÉGE nem mért — a geometric-shapes blokk java "ambiguous width",
 * ami CJK-kontextusban 2 cellára ugrik. A user NÉGYSZER jelentette be az
 * oszlop-csúszást, aminek pontosan az a gyökere, hogy valaki egy glif
 * szélességét megtippelte. Glifet CSAK mérés után cserélünk; a szín ingyen van.
 */
export function reviewTraceFlag(has) {
  return has === true ? { label: REVIEW_TRACE_GLYPH, color: 'whiteBright' } : null
}


// --- Az AI-review VÁLASZ-FINDINGJAI: a cache-állapotgép hibrid szelete ---
//
// Ezek MA a hibrid-findings szekcióban laktak, de cache-állapotot kezelnek
// (a `cache.aiFindings` Map-et), ezért a cache-modul a helyük.
/**
 * A VÁLASZ-FINDINGOK TÁROLÁSA — PR-ra kulcsolva, az `applied` flaggel.
 *
 * KÜLÖN a mérés-bejegyzésektől (`entries`) és a nyomtól (`reviewTrace`), mert
 * MÁS a természete: a finding KIFIZETETT TÉNY (a költés megtörtént), nem
 * mérés — nem avul a main elmozdulásával, és az `R` sem dobhatja el. Ha az
 * `R` törölné, a "review lefutott, minden elveszett" kár egy reflexszerű
 * refresh-sel újra előállna.
 */
export function cacheStoreAiFindings(cache, pr, findings) {
  if (!Array.isArray(findings)) {
    throw new Error(`a válasz-findingok nem tömbként érkeztek: ${JSON.stringify(findings)}`)
  }
  cache.aiFindings.set(pr, { findings, applied: false })
  return cache
}

/** A PR eltárolt válasz-findingjai (`{ findings, applied }`), vagy null. */
export function cacheAiFindings(cache, pr) {
  return cache?.aiFindings?.get(pr) ?? null
}

/**
 * A betöltés megtörtént: az `applied` flag áll, ÉS a CÉLSESSION azonosítója is
 * rögzül. EZ az idempotencia-kapu — de a kapu SESSION-IDENTITÁSHOZ kötött, nem
 * csak a PR-hoz (a user 5/3-as lelete): a hunk `q`-ja a sessiont is elviszi,
 * és az `applied` egy HALOTT sessionre nézve hazug "kész"-t mondana — az új,
 * üres session betöltés nélkül maradna, a note-ok "eltűnnének".
 *
 * A `sessionId` null/undefined esetén NEM íródik: a guard ilyenkor fail-safe
 * (nem duplikál — lásd answerFindingsNeedApply).
 */
export function cacheMarkAiFindingsLoaded(cache, pr, sessionId) {
  const cur = cache.aiFindings.get(pr)
  if (cur) {
    cache.aiFindings.set(pr, {
      ...cur,
      applied: true,
      ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
    })
  }
  return cache
}

/**
 * KELL-E BETÖLTENI a cache-elt válasz-findingokat a megnyitáskor — a
 * SESSION-IDENTITÁSHOZ kötött guard TISZTA döntése.
 *
 * A NÉGY ÁG, kimondva:
 *   - nincs pending / üres findings → NEM (nincs mit);
 *   - még nem applied → IGEN (az első betöltés);
 *   - applied, és a rögzített célsession MA IS ÉL (azonos id) → NEM — ez a
 *     "nem duplikál élő sessionben" invariáns (ismételt Enter/r sem duplikál);
 *   - applied, de a célsession MEGSZŰNT vagy MÁS session él → IGEN: az új
 *     sessionben a note-ok nincsenek ott, a másolatból újratöltjük őket
 *     (a user 5/3-as lelete — az újbóli `r` üres review-t adott).
 *
 * FAIL-SAFE ÁG: applied, de NINCS rögzített sessionId (a betöltéskor a session
 * list nem volt mérhető) → NEM töltünk újra. A két hibairány közül a duplikáció
 * a rosszabb (a user a hunkban KÉTSZER látná ugyanazt a findingot, és a
 * feltöltés is duplán vinné fel); a kihagyás legfeljebb a régi, ismert
 * viselkedés marad.
 */
export function answerFindingsNeedApply(pending, liveSessionId) {
  if (!pending || !Array.isArray(pending.findings) || pending.findings.length === 0) return false
  if (pending.applied !== true) return true
  if (typeof pending.sessionId !== 'string' || pending.sessionId === '') return false
  return pending.sessionId !== liveSessionId
}

/**
 * A cache-elt AI-findingok EXPLICIT ELVETÉSE (a dupla-`x` második nyomása).
 *
 * CSAK a findingokat dobja el — a REVIEW-NYOM (reviewTraces) MARAD: a review
 * megtörtént és a költés valós tény, az elvetés csak az eredmény-példányt
 * takarítja el. Az újraindítás előfeltétele pont ez az elvetés (lásd az `r`
 * életciklusát): szándékos súrlódás a véletlen dupla-költés ellen.
 */
export function cacheDiscardAiFindings(cache, pr) {
  cache?.aiFindings?.delete(pr)
  return cache
}

/**
 * A MÉG BE NEM TÖLTÖTT, KIFIZETETT válasz-findingokat hordozó PR-ok.
 *
 * FIGYELEM — MA NINCS FOGYASZTÓJA A TUI-BAN (wf31/9). Eredetileg a
 * kilépés-guard bemenete volt (nema-veszteseg-1): a findings-cache akkor CSAK a
 * process memóriájában élt, tehát egy néma `q` tényleg eldobta a kifizetett
 * eredményt. A disk-cache (review-store) óta ez nem áll: a findingok a `/tmp`-be
 * mentve MEGMARADNAK, és az indulás visszaolvassa őket — a guard így nem
 * veszteséget előzött meg, hanem a cache működéséről tájékoztatott. A user
 * döntése szerint a cache automatikus default, amiről nem kell szólni, ezért a
 * pending-ág kivezetve.
 *
 * MIÉRT MARAD MÉGIS: tiszta, tesztelt selector a cache-állapot fölött ("van-e
 * félbehagyott, kifizetett munka"), aminek jövőbeli fogyasztója lehet (pl. egy
 * összegző jelzés a fejlécben). Törlésre akkor érdemes, ha ez nem valósul meg.
 *
 * Az `applied !== true` + nem-üres findings a mérce: az applied példány már a
 * hunkban van (vagy a session-identitás-guard dönt róla megnyitáskor), az üres
 * lista pedig nem veszteség.
 */
export function cacheUnappliedAiFindingPrs(cache) {
  const out = []
  for (const [pr, v] of cache?.aiFindings?.entries?.() ?? []) {
    if (v?.applied !== true && Array.isArray(v?.findings) && v.findings.length > 0) out.push(pr)
  }
  return out
}
