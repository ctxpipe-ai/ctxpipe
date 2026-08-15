#!/usr/bin/env node
import { createRequire } from "node:module"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

const require = createRequire(import.meta.url)
const fontkit = require("fontkit")

export function layoutWord(fontPath, text, { size = 36, tracking = 0 } = {}) {
  const font = fontkit.openSync(fontPath)
  const run = font.layout(text)
  const s = size / font.unitsPerEm
  const glyphs = []
  let x = 0
  for (let i = 0; i < run.glyphs.length; i++) {
    const g = run.glyphs[i]
    const pos = run.positions[i]
    glyphs.push({
      char: text[i],
      d: g.path.toSVG(),
      x,
      adv: pos.xAdvance * s,
      box: {
        x0: g.cbox.minX * s,
        y0: g.cbox.minY * s,
        x1: g.cbox.maxX * s,
        y1: g.cbox.maxY * s,
      },
    })
    x += pos.xAdvance * s + tracking
  }
  return { glyphs, width: x, size, scale: s, unitsPerEm: font.unitsPerEm }
}

export function wordmarkSvg(
  fontPath,
  {
    size = 36,
    tracking = 0,
    ink = "#F4F4F5",
    pipe = "#40E0D0",
    pad = 4,
    pipeScaleX = 1,
    pipeLift = 0,
    pipeKern = 0,
  } = {},
) {
  const laid = layoutWord(fontPath, "ctx|", { size, tracking })
  const { glyphs, scale } = laid
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const parts = []
  for (const g of glyphs) {
    const isPipe = g.char === "|"
    const sx = isPipe ? pipeScaleX : 1
    const ox =
      g.x +
      (isPipe ? pipeKern + (g.adv * (1 - pipeScaleX)) / 2 : 0)
    const oy = isPipe ? pipeLift : 0
    const fill = isPipe ? pipe : ink
    parts.push(
      `<g transform="translate(${ox.toFixed(2)} ${oy.toFixed(2)}) scale(${(scale * sx).toFixed(5)},${(-scale).toFixed(5)})" fill="${fill}"><path d="${g.d}"/></g>`,
    )
    const x0 = ox + g.box.x0 * sx
    const x1 = ox + g.box.x1 * sx
    const y0 = -g.box.y1 + oy
    const y1 = -g.box.y0 + oy
    minX = Math.min(minX, x0)
    maxX = Math.max(maxX, x1)
    minY = Math.min(minY, y0)
    maxY = Math.max(maxY, y1)
  }
  minX -= pad
  minY -= pad
  maxX += pad
  maxY += pad
  const w = maxX - minX
  const h = maxY - minY
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(1)}" height="${h.toFixed(1)}" viewBox="${minX.toFixed(2)} ${minY.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}" fill="none">\n${parts.join("\n")}\n</svg>\n`
}

export function pipeMarkSvg(
  fontPath,
  {
    size = 64,
    fill = "#40E0D0",
    inset = 18,
    barScaleX = 1,
  } = {},
) {
  const laid = layoutWord(fontPath, "|", { size: size - inset * 2 })
  const { glyphs, scale } = laid
  const g = glyphs[0]
  const glyphH = g.box.y1 - g.box.y0
  const glyphW = (g.box.x1 - g.box.x0) * barScaleX
  const ox = (size - glyphW) / 2 - g.box.x0 * barScaleX
  const oy = (size + glyphH) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">
  <g transform="translate(${ox.toFixed(2)} ${oy.toFixed(2)}) scale(${(scale * barScaleX).toFixed(5)},${(-scale).toFixed(5)})" fill="${fill}"><path d="${g.d}"/></g>
</svg>\n`
}

export function hintedPipe16({ fill = "#40E0D0", w = 4, h = 14, size = 16 } = {}) {
  const x = Math.round((size - w) / 2)
  const y = Math.round((size - h) / 2)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" shape-rendering="crispEdges">
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>
</svg>\n`
}

export function write(path, svg) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, svg)
}

const PIXEL = new URL("../../../apps/ui/public/fonts/GeistPixel-Square.woff2", import.meta.url)
const GEIST = "/tmp/geist-fonts/Geist-Medium.woff2"

if (import.meta.main) {
  const [, , cmd, out, ...rest] = process.argv
  const face = rest.includes("--pixel") ? PIXEL.pathname : GEIST
  const light = rest.includes("--light")
  const ink = light ? "#09090B" : "#F4F4F5"
  const pipe = light ? "#0F766E" : "#40E0D0"
  if (cmd === "word") write(out, wordmarkSvg(face, { ink, pipe }))
  else if (cmd === "mark") write(out, pipeMarkSvg(face, { fill: light ? ink : pipe }))
  else if (cmd === "mark16") write(out, hintedPipe16({ fill: light ? ink : pipe }))
  else {
    console.error("word|mark|mark16 out [--pixel] [--light]")
    process.exit(1)
  }
}
