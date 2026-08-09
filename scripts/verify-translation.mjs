#!/usr/bin/env node

// Proves that a translation changed ONLY text, not code.
//
// WHY `node --check` ISN'T ENOUGH: that certifies the syntax, not the
// MEANING. A translator who, in good faith, rewrites an object KEY or a
// literal used in a comparison is syntactically flawless, but leaves silently
// broken code behind — and that's precisely translation's most dangerous
// error class, because nothing signals it.
//
// THE METHOD: from both versions we extract the code's SKELETON (comments
// dropped, every string literal replaced with a single `"S"` placeholder),
// and compare the two skeletons. If they match, then provably only comments
// and string CONTENTS changed — identifiers, operators, keys, numbers, and
// structure are untouched.
//
// WHAT THIS DOES NOT CATCH (a deliberate limit, stated outright): if a
// DISPLAY string's content and a COMPARISON string's content both changed,
// the skeleton sees both as `"S"`. So for key-like literals, the prompt's
// prohibition and human review remain the safeguard — this script is the
// structural guarantee, not the complete one.
//
// EXPECT FALSE ALARMS ON TEMPLATE LITERALS, AND DO NOT SUPPRESS THEM. English
// word order differs from Hungarian, so a faithful translation legitimately
// MOVES an interpolation inside a sentence, and sometimes ADDS one where the
// source left the subject implicit ("wait for it to land" → "wait for
// #${culprit} to land"). Both change the skeleton. The script cannot tell that
// apart from a variable smuggled into code — and it should not try: the
// correct response is to read the diff, which is exactly the attention this
// tool exists to direct.
//
// USAGE:
//   node scripts/verify-translation.mjs <git-ref> <file...>
//   (<git-ref> is the state BEFORE the translation, e.g. a commit SHA)

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'

/**
 * The code's skeleton: no comments, every string literal replaced with `"S"`.
 *
 * THE CHARACTER-BY-CHARACTER STATE MACHINE IS DELIBERATE, not laziness: a
 * regex is unreliable for this task (an apostrophe in a comment, a `//`
 * inside a string, an escaped quote — any of these breaks it). The
 * tokenizing here only needs to know where a string or comment IS, it doesn't
 * need to understand the grammar.
 */
function skeleton(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]

    // Line comment
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    // Block comment
    if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    // Simple string literal
    if (c === '"' || c === "'") {
      const quote = c
      i++
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === quote) { i++; break }
        i++
      }
      out += '"S"'
      continue
    }
    // TEMPLATE LITERAL — and here the `${…}` is NOT text, it's CODE.
    //
    // WHY A SINGLE `"S"` FOR IT ISN'T ENOUGH: an expression like
    // `${row.number}` holds an identifier, which the translation must leave
    // untouched. If we replaced the whole template with one placeholder, a
    // field broken in there would SLIP PAST the check — exactly the error
    // class this script was built against.
    //
    // So: the TEXT chunks get `"S"`, but the inside of `${…}` continues on as
    // code (recursively, because it can contain a string, and even another
    // template). `depth` counts `{}` pairs, so an object literal inside the
    // expression doesn't close it early.
    if (c === '`') {
      i++
      out += '"S"'
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '`') { i++; break }
        if (src[i] === '$' && src[i + 1] === '{') {
          let depth = 1
          let j = i + 2
          const start = j
          while (j < n && depth > 0) {
            const ch = src[j]
            if (ch === '{') depth++
            else if (ch === '}') depth--
            else if (ch === '"' || ch === "'" || ch === '`') {
              const q = ch
              j++
              while (j < n) {
                if (src[j] === '\\') { j += 2; continue }
                if (src[j] === q) break
                j++
              }
            }
            j++
          }
          out += `\${${skeleton(src.slice(start, j - 1))}}`
          i = j
          continue
        }
        i++
      }
      continue
    }
    out += c
    i++
  }
  // Whitespace normalization: a translation can move a line break around a
  // comment, which doesn't affect the code.
  out = out.replace(/\s+/g, ' ').trim()
  // MERGING ADJACENT STRING CONCATENATION. A translator can break a long
  // piece of text into a DIFFERENT NUMBER of literals (`'a' + 'b'` →
  // `'a' + 'b' + 'c'`), which does not change the RESULT — only the line
  // break. Without this, every re-wrapped message would trigger a false
  // alarm, and a verifier that produces noise is only as trustworthy as we
  // let it be.
  //
  // WHAT THIS DOES NOT LOOSEN: the concatenation only merges if BOTH sides
  // are literals. A `'a' + variable` structure stays untouched, so an
  // expression smuggled into the code is still caught.
  let prev
  do {
    prev = out
    out = out.replace(/"S" \+ "S"/g, '"S"')
  } while (out !== prev)
  return out
}

const [ref, ...files] = process.argv.slice(2)
if (!ref || files.length === 0) {
  process.stderr.write('usage: verify-translation.mjs <git-ref> <file...>\n')
  process.exit(2)
}

let failed = 0
for (const file of files) {
  let before
  try {
    before = execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    process.stdout.write(`?  ${file} — not found at ref ${ref}, skipped\n`)
    continue
  }
  const after = readFileSync(file, 'utf8')
  if (skeleton(before) === skeleton(after)) {
    process.stdout.write(`OK ${file}\n`)
  } else {
    process.stdout.write(`DIFFERS ${file} — the code's SKELETON changed, not just the text\n`)
    // A bare "differs" is useless on a 1500-line file: the caller needs to see
    // WHERE. The neighbourhood of the first divergence is enough, and stays
    // short — later differences are usually consequences of the same one.
    const a = skeleton(before)
    const b = skeleton(after)
    let k = 0
    while (k < a.length && k < b.length && a[k] === b[k]) k++
    process.stdout.write(`   before: …${a.slice(Math.max(0, k - 90), k + 40)}…\n`)
    process.stdout.write(`   after : …${b.slice(Math.max(0, k - 90), k + 40)}…\n`)
    failed++
  }
}
process.exit(failed === 0 ? 0 : 1)
