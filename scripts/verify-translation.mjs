#!/usr/bin/env node

// Bizonyítja, hogy egy fordítás CSAK szöveget változtatott, kódot nem.
//
// MIÉRT NEM ELÉG A `node --check`: az a szintaxist igazolja, a JELENTÉST nem.
// Egy fordító, aki jóhiszeműen átír egy objektum-KULCSOT vagy egy
// összehasonlításban használt literált, szintaktikailag hibátlan, de csendben
// hibás kódot hagy maga után — és pont ez a fordítás legveszélyesebb
// hibaosztálya, mert semmi nem jelzi.
//
// A MÓDSZER: mindkét változatból kivonjuk a kód VÁZÁT (a kommentek eldobva,
// minden string-literál egyetlen `"S"` helyőrzőre cserélve), és a két vázat
// összehasonlítjuk. Ha egyeznek, akkor bizonyítottan csak kommentek és
// string-TARTALMAK változtak — az azonosítók, operátorok, kulcsok, számok és a
// szerkezet érintetlen.
//
// AMIT EZ NEM FOG MEG (szándékos korlát, kimondva): ha egy DISPLAY-string
// tartalma és egy ÖSSZEHASONLÍTÁSI string tartalma is megváltozott, a váz
// mindkettőt `"S"`-nek látja. Ezért a kulcs-jellegű literálokra a prompt tiltása
// és az emberi átnézés marad a védelem — ez a szkript a szerkezeti garancia,
// nem a teljes.
//
// HASZNÁLAT:
//   node scripts/verify-translation.mjs <git-ref> <fájl...>
//   (a <git-ref> a fordítás ELŐTTI állapot, pl. egy commit SHA)

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'

/**
 * A kód váza: kommentek nélkül, minden string-literál `"S"`-re cserélve.
 *
 * A KARAKTERENKÉNTI ÁLLAPOTGÉP SZÁNDÉKOS, nem lustaság: regexszel ez a feladat
 * megbízhatatlan (egy aposztróf egy kommentben, egy `//` egy stringben, egy
 * escape-elt idézőjel — mind elrontja). A tokenizálás itt csak annyit kell
 * tudjon, hogy hol VAN string és komment, a nyelvtant nem kell értenie.
 */
function skeleton(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]

    // Sorkomment
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    // Blokk-komment
    if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    // String-literál (', ", `) — a template-literál ${…} részeit is elnyeli,
    // ami itt megengedhető: a benne lévő kód is a szövegréteghez tartozik.
    if (c === '"' || c === "'" || c === '`') {
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
    out += c
    i++
  }
  // A whitespace normalizálása: a fordítás sortörést mozgathat egy komment
  // körül, ami a kódot nem érinti.
  return out.replace(/\s+/g, ' ').trim()
}

const [ref, ...files] = process.argv.slice(2)
if (!ref || files.length === 0) {
  process.stderr.write('használat: verify-translation.mjs <git-ref> <fájl...>\n')
  process.exit(2)
}

let failed = 0
for (const file of files) {
  let before
  try {
    before = execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    process.stdout.write(`?  ${file} — nincs meg a ${ref} refben, kihagyva\n`)
    continue
  }
  const after = readFileSync(file, 'utf8')
  if (skeleton(before) === skeleton(after)) {
    process.stdout.write(`OK ${file}\n`)
  } else {
    process.stdout.write(`ELTÉR ${file} — a kód VÁZA megváltozott, nem csak a szöveg\n`)
    failed++
  }
}
process.exit(failed === 0 ? 0 : 1)
