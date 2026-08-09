#!/usr/bin/env node

// tuipr — the entry point of the installed command.
//
// Deliberately thin: the logic lives in `src/tui.mjs`, this only starts it. It
// does NOT rely on the entry heuristic (`import.meta.url === argv[1]`), because
// once installed THIS file is the main module, not `src/tui.mjs` — so the
// `isMain` check over there would be false, and the TUI would return silently
// with zero bytes of output. Hence the explicit call to `main()`.
//
// ERROR HANDLING IS LOUD: every unexpected error is reported with its full
// stack trace. There is no silent exit branch — that error class has already
// bitten this project in production once.

import process from 'node:process'
import { main } from '../src/tui.mjs'

try {
  await main()
} catch (error) {
  process.stderr.write(`tuipr: ${error?.stack || error}\n`)
  process.exit(1)
}
