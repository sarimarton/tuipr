// tui-core — a review-munkaállomás TISZTA logikájának BARRELJE.
//
// EZ A FÁJL MA MÁR CSAK ÚJRAEXPORTÁL. A tényleges implementáció a bin/next/*
// modulokban él (lásd a rétegrendet lentebb); ez a modul a KÜLSŐ SZERZŐDÉS
// egyetlen belépési felülete a core felé.
//
// MIÉRT MARAD MEG, ha semmit nem implementál: a fogyasztók 175 nevet EZEN AZ
// ÚTON címeznek — a test/next.test.ts a `mergeBlockers`-t innen importálja, a
// test/verify-silent.test.ts 16 dinamikus `import()`-tal ezt a fájlt tölti be, a
// next-tui / next-poll / next-cache tesztek szintén. A barrel a modul-vágást a
// fogyasztók számára LÁTHATATLANNÁ teszi.
//
// Miért KÜLÖN modul a belépési ponttól (tui.mjs) és a React-rétegtől
// (tui-app.mjs): korábban a belépési pont maga tartotta ezeket a
// függvényeket, az app.mjs pedig visszaimportált rá — ez KÖRKÖRÖS ESM-import
// volt. Entryként futtatva a ciklus nem tud bezáródni (a modul még kiértékelés
// alatt van, amikor az app visszaimportál), így a dinamikus import top-level
// await-je sosem settle-elt: a node exit 13-cal, ÜRES kimenettel halt meg — a
// TTY-s `queue` néma no-op volt. A függőségi irány ezért most SZIGORÚAN egyirányú:
//
//   tui.mjs (entry) ──> tui-app.mjs (React/Ink) ──┐
//                     └────────────────────────────────────────────> core
//
// A core SENKIT nem importál a másik kettő közül, és nem importál vissza saját
// magára. Ezt a test/next-tui-module.test.ts statikus invariánsként is ellenőrzi, a
// belépési pontot pedig smoke-teszt indítja el valódi processzként.
//
// A BIN/NEXT/* RÉTEGREND (a nyíl "importálja" irányban, SOSEM visszafelé):
//
//   layout, proc, review-store       ← nulla projekt-import (a legalsó réteg)
//     ├─> cache, rows, merge
//     ├─> poll, queue-fetch, hunk ─> hunk-findings
//     ├─> allowlist, diagnosis
//     │     └─> ai-review-config ─> ai-review-view
//     │           └─> ai-review-run ─> ai-review-agent
//     └─> panel                      ← a legfelső core-réteg
//
// A KÖRKÖRÖS IMPORT TILOS, és ezt GÉPILEG őrizzük: a
// scripts/check-next-modules.mjs statikus gráfot épít és cikluson bukik — MÉG A
// MODUL BETÖLTÉSE ELŐTT, mert maga a ciklus fagyasztaná meg az ellenőrzőt is
// (MÉRVE: egy szándékos layout→rows ciklus 2 percre akasztotta a checkert).
// Ugyanaz a script a SZABAD (fel nem oldott) identifiereket is elkapja: az ESM
// azokat nem a betöltéskor, hanem a HÍVÁSKOR oldja fel, tehát egy rossz helyre
// került függvény minden `import`-tal ÁTMEGY, és csak élesben dob. MÉRVE ezen a
// vágáson: a rows.mjs egy core-ban maradt `reviewSpinnerFlag`-et hívott — mind a
// 9 modul "loads OK" volt, mégis 58 teszt bukott.
//
// Az adatforrás KIZÁRÓLAG az `tuipr queue --json` (a (b) csomag kanonikus
// modellje) — a klasszifikációt, a landolhatóságot és az approve-olhatóságot itt
// NEM számoljuk újra, csak leképezzük. Ez szándékos: a duplikált döntési lánc
// szülte azt az elcsúszást, amit a (b) csomag épp megszüntetett.
//
// Az akciók (review / findings / approve / merge) a meglévő NON-INTERAKTÍV
// utakat hívják (`tuipr approve --yes`, `gh pr merge`, `gh api`), tehát a
// TUI vezérlő, nem pedig párhuzamos implementáció.
//
// A tiszta függvények (buildRows / canApproveRow / canMergeRow / displayWidth /
// titleBudget / reviewBody / reviewCommand / toGithubComments) a
// test/next-tui.test.ts-ben unit-teszt alatt vannak. A process-indítók
// (fetchQueue / fetchPrRefs / hunkComments / uploadFindings) manuális
// verifikációt kapnak.

export * from './lib/ai-review-config.mjs'
export * from './lib/ai-review-agent.mjs'
export * from './lib/ai-review-run.mjs'
export * from './lib/ai-review-view.mjs'
export * from './lib/allowlist.mjs'
export * from './lib/cache.mjs'
export * from './lib/conflict-resolve.mjs'
export * from './lib/diagnosis.mjs'
export * from './lib/hunk-findings.mjs'
export * from './lib/hunk.mjs'
export * from './lib/layout.mjs'
export * from './lib/merge.mjs'
export * from './lib/panel.mjs'
export * from './lib/term-colors.mjs'
export * from './lib/poll.mjs'
export * from './lib/proc.mjs'
export * from './lib/queue-fetch.mjs'
export * from './lib/review-menu.mjs'
export * from './lib/review-store.mjs'
export * from './lib/rows.mjs'
