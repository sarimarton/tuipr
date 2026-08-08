#!/usr/bin/env node

// Placeholder entry point.
//
// The package name is reserved while the tool is being extracted from a
// private codebase and generalized. This file exists so that anyone who
// installs the package gets an honest answer instead of a silent no-op —
// a released `bin` that does nothing is worse than no release at all.
//
// It is deliberately dependency-free and prints to stderr with a non-zero
// exit, so a script that shells out to `tuidash` fails loudly rather than
// appearing to succeed.

process.stderr.write(
  [
    'tuidash is not released yet — this is a reserved package name.',
    '',
    'The tool is a terminal review workstation for agent-generated pull',
    'requests: a PR queue with computed landability, hunk-level diff review,',
    'budgeted AI review runs, and approvals that leave an attestation in the',
    'audit trail.',
    '',
    'Progress and release notes: https://github.com/sarimarton/tuidash',
    '',
  ].join('\n'),
)

process.exit(1)
