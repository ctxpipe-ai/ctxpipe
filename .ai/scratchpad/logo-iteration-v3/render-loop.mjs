#!/usr/bin/env node
import { spawnSync } from "node:child_process"

const integrity = "/workspace/.cursor/skills/logo-design/render-integrity.mjs"
const four = "/workspace/.ai/scratchpad/logo-iteration-v3/render-four.mjs"
const R = "/workspace/.ai/scratchpad/logo-iteration-v3"

const loops = {
  "06": {
    title: "Loop 6 — from chamfer",
    items: [
      ["a", "chamfer+echo", "a-chamfer-echo"],
      ["b", "deep cut", "b-deep-cut"],
      ["c", "pixel type", "c-type"],
      ["d", "negative", "d-negative"],
    ],
  },
  "07": {
    title: "Loop 7 — architectures",
    items: [
      ["a", "stack", "a-stack"],
      ["b", "all teal", "b-all-teal"],
      ["c", "stair", "c-stair"],
      ["d", "combo", "d-combo"],
    ],
  },
  "08": {
    title: "Loop 8 — optical",
    items: [
      ["a", "tight", "a-tight"],
      ["b", "taller", "b-taller"],
      ["c", "no echo", "c-no-echo"],
      ["d", "gap", "d-gap"],
    ],
  },
  "09": {
    title: "Loop 9 — color system",
    items: [
      ["a", "color", "a-color"],
      ["b", "mono", "b-mono"],
      ["c", "ink block", "c-ink-block"],
      ["d", "darker light", "d-darker"],
    ],
  },
  "10": {
    title: "Loop 10 — finish",
    items: [
      ["a", "ref", "a-ref"],
      ["b", "heavy", "b-heavy"],
      ["c", "sharp", "c-sharp"],
      ["d", "quiet echo", "d-quiet-echo"],
    ],
  },
}

const n = process.argv[2]
const spec = loops[n]
if (!spec) throw new Error(n)
const L = `${R}/loops/${n}`
for (const [letter, label, stem] of spec.items) {
  const dark = n === "09" && letter === "d" ? `${L}/d-darker-dark.svg` : `${L}/${stem}-dark.svg`
  const light = n === "09" && letter === "d" ? `${L}/d-darker-light.svg` : `${L}/${stem}-light.svg`
  spawnSync(
    "node",
    [
      integrity,
      dark,
      light,
      `${L}/${letter}-mark.svg`,
      `${R}/renders/${n}-${letter}.png`,
      `${spec.title} ${letter}`,
      `${L}/${letter}-mark16.svg`,
      `${L}/${letter}-mark-mono.svg`,
      dark,
    ],
    { stdio: "inherit" },
  )
  void label
}
const args = [four, spec.title, `${R}/renders/${n}-four.png`]
for (const [letter, label, stem] of spec.items) {
  const dark = n === "09" && letter === "d" ? `${L}/d-darker-dark.svg` : `${L}/${stem}-dark.svg`
  const light = n === "09" && letter === "d" ? `${L}/d-darker-light.svg` : `${L}/${stem}-light.svg`
  args.push(`${letter.toUpperCase()} ${label}|${dark}|${light}`)
}
spawnSync("node", args, { stdio: "inherit" })
