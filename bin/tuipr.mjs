#!/usr/bin/env node

// tuipr — a telepített parancs belépési pontja.
//
// Szándékosan vékony: a logika a `src/tui.mjs`-ben él, ez csak elindítja. NEM
// az entry-heurisztikára bízzuk magunkat (`import.meta.url === argv[1]`), mert
// telepítve ez a fájl a main, nem a `src/tui.mjs` — az ottani `isMain` tehát
// hamis lenne, és a TUI némán, 0 bájt kimenettel térne vissza. Ezért expliciten
// a `main()`-t hívjuk.
//
// A HIBAKEZELÉS HANGOS: minden váratlan hiba teljes stack trace-szel dobódik.
// Néma exit-ág nincs — az a hibaosztály itt már egyszer élesben harapott.

import process from 'node:process'
import { main } from '../src/tui.mjs'

try {
  await main()
} catch (error) {
  process.stderr.write(`tuipr: ${error?.stack || error}\n`)
  process.exit(1)
}
