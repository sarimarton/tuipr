#!/usr/bin/env node

// @sarimarton/tuigh — a thin alias of tuipr. One product, one source of truth.
//
// WHY SCOPED: the bare name `tuigh` cannot be published by anyone — npm's
// typosquat rule rejects it as too similar to `twig`. This package exists so
// that the name still leads somewhere on the registry, and so `npm i -g
// @sarimarton/tuigh` yields a working `tuigh` command. (Installing plain
// `tuipr` also provides `tuigh` — the binary ships under both names.)
//
// The dependency is `tuipr@*` on purpose: an alias must always mean the
// current release, and a caret range on a 0.x version would silently pin it
// to a stale minor.
//
// WHY import() AND NOT A SHELL SHIM: a shell line would hardcode a relative
// node_modules path and break under hoisting or pnpm layouts. The module
// resolver is the one component that always knows where the dependency is.

import 'tuipr/bin/tuipr.mjs'
