#!/usr/bin/env node

// tuigh — a thin alias of tuipr. One product, one source of truth.
//
// This package exists so the name and the five-character command belong to the
// project rather than to whoever registers them first. It carries NO logic of
// its own: it resolves tuipr's entry through normal dependency resolution and
// runs it. When tuipr releases a real version, bumping the dependency makes
// this a working alias with nothing else to do.
//
// WHY import() AND NOT A SHELL SHIM: a shell line would hardcode a relative
// node_modules path and break under hoisting or pnpm layouts. The module
// resolver is the one component that always knows where the dependency is.

import 'tuipr/bin/tuipr.mjs'
