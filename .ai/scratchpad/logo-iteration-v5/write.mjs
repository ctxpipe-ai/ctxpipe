import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export function write(path, svg) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, svg)
}

export function wrap(w, h, inner, { vb = `0 0 ${w} ${h}` } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${vb}" fill="none">\n${inner}\n</svg>\n`
}

export function family(root, letter, dark, light, m64, m64mono, m16) {
  write(root + `${letter}-dark.svg`, dark)
  write(root + `${letter}-light.svg`, light)
  write(root + `${letter}-mark.svg`, m64)
  write(root + `${letter}-mark-mono.svg`, m64mono)
  write(root + `${letter}-mark16.svg`, m16)
}
