#!/usr/bin/env node

// Egy VALÓDI terminál-képernyőt SVG-vé alakít, hogy a README és a landing egy
// futó tool képét mutathassa.
//
// MIÉRT NEM KÉPERNYŐFOTÓ: a raszteres kép elmosódik, nem kereshető, sötét/világos
// témára nem reagál, és minden frissítéskor kézi munkát igényel. Az SVG szöveg
// marad: éles minden felbontáson, verziókövethető, és a diffje olvasható.
//
// MIÉRT NEM KÜLSŐ ESZKÖZ: az asciinema/vhs/agg mind telepítést kíván. A bemenet
// (`tmux capture-pane -e`) viszont már ANSI-t ad, és a fordítás annyira szűk
// feladat, hogy egy külső függőség többe kerülne, mint amennyit ér.
//
// HASZNÁLAT:  tmux capture-pane -t <pane> -e -p | node scripts/ansi-to-svg.mjs > demo.svg

import process from 'node:process'

// Az alap-16 paletta. SZÁNDÉKOSAN nem egy terminál-emulátor pontos témája: a
// cél a hitelesség, nem a bájt-azonosság — ezek a színek sötét háttéren
// olvashatók, és a WCAG-kontrasztot tartják.
const PALETTE = [
  '#1c1b18', '#e05252', '#7fb069', '#e0a458', '#5b9bd5', '#b07fc7', '#4fb3a5', '#d6d3cb',
  '#6b6862', '#f07171', '#98c379', '#f0c674', '#7cb7e8', '#c8a2d8', '#6fd3c4', '#f5f3ee',
]
const FG_DEFAULT = '#e6e3db'
const BG = '#14130f'

const CELL_W = 8.4
const CELL_H = 18
const PAD = 16

/** Egy cella stílusa. A `bold` külön mező, mert a fontweightet a tspan hordozza. */
function newStyle() {
  return { fg: null, bold: false, dim: false, inverse: false }
}

/**
 * SGR-paraméterek alkalmazása. CSAK azt kezeljük, amit egy TUI valóban használ
 * (szín, bold, dim, inverse, reset) — a többit SZÁNDÉKOSAN eldobjuk, mert egy
 * félig implementált ritka attribútum rosszabb, mint a hiánya: hamis képet adna.
 */
function applySgr(style, params) {
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    if (p === 0) { Object.assign(style, newStyle()); continue }
    if (p === 1) { style.bold = true; continue }
    if (p === 2) { style.dim = true; continue }
    if (p === 7) { style.inverse = true; continue }
    if (p === 22) { style.bold = false; style.dim = false; continue }
    if (p === 27) { style.inverse = false; continue }
    if (p === 39) { style.fg = null; continue }
    if (p >= 30 && p <= 37) { style.fg = PALETTE[p - 30]; continue }
    if (p >= 90 && p <= 97) { style.fg = PALETTE[p - 90 + 8]; continue }
    // 38;5;N — a 256-os paletta. Az első 16 a fenti; a többit a szürke- és a
    // színkockából közelítjük, mert a pontos leképzés itt nem ér annyit.
    if (p === 38 && params[i + 1] === 5) {
      const n = params[i + 2]
      i += 2
      if (n < 16) style.fg = PALETTE[n]
      else if (n >= 232) { const v = Math.round(((n - 232) / 23) * 255).toString(16).padStart(2, '0'); style.fg = `#${v}${v}${v}` }
      else {
        const c = n - 16
        const to = (x) => Math.round((x / 5) * 255).toString(16).padStart(2, '0')
        style.fg = `#${to(Math.floor(c / 36))}${to(Math.floor((c % 36) / 6))}${to(c % 6)}`
      }
    }
  }
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Egy sor ANSI-szövegét egyforma stílusú darabokra bontja. */
function parseLine(line, style) {
  const spans = []
  let buf = ''
  let cur = { ...style }
  let i = 0
  const flush = () => {
    if (buf) { spans.push({ text: buf, style: { ...cur } }); buf = '' }
  }
  while (i < line.length) {
    if (line[i] === '' && line[i + 1] === '[') {
      let j = i + 2
      while (j < line.length && !/[a-zA-Z]/.test(line[j])) j++
      const body = line.slice(i + 2, j)
      const final = line[j]
      if (final === 'm') {
        flush()
        applySgr(style, body.split(';').map((x) => (x === '' ? 0 : Number(x))))
        cur = { ...style }
      }
      i = j + 1
      continue
    }
    buf += line[i]
    i++
  }
  flush()
  return spans
}

const input = await new Promise((resolve) => {
  let s = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => { s += d })
  process.stdin.on('end', () => resolve(s))
})

// A záró üres sorokat levágjuk — a tmux a pane teljes magasságát adja, és egy
// félig üres kép azt sugallná, hogy a tool nem tölti ki a képernyőt.
const lines = input.replace(/\s+$/, '').split('\n')
const cols = Math.max(...lines.map((l) => l.replace(/\[[0-9;]*[a-zA-Z]/g, '').length))
const width = Math.ceil(cols * CELL_W + PAD * 2)
const height = Math.ceil(lines.length * CELL_H + PAD * 2)

const style = newStyle()
const rows = lines.map((line, idx) => {
  const spans = parseLine(line, style)
  const y = PAD + (idx + 1) * CELL_H - 5
  let x = PAD
  const parts = spans.map((s) => {
    const text = escapeXml(s.text)
    const cellCount = s.text.length
    const attrs = []
    const fill = s.style.inverse ? BG : (s.style.fg || FG_DEFAULT)
    attrs.push(`fill="${fill}"`)
    if (s.style.bold) attrs.push('font-weight="600"')
    if (s.style.dim) attrs.push('opacity="0.55"')
    const el = `<tspan x="${x.toFixed(1)}" ${attrs.join(' ')} xml:space="preserve">${text}</tspan>`
    x += cellCount * CELL_W
    return el
  })
  return `<text y="${y}">${parts.join('')}</text>`
})

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="13">
<rect width="${width}" height="${height}" rx="8" fill="${BG}"/>
${rows.join('\n')}
</svg>
`)
