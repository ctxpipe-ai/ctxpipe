#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const R = resolve(new URL(".", import.meta.url).pathname)
const integrity = "/workspace/.cursor/skills/logo-design/render-integrity.mjs"
const four = resolve(R, "render-four.mjs")

const n = process.argv[2]
const title = process.argv[3]
const basisLabel = process.argv[4]
const basisDark = resolve(process.argv[5])
const basisLight = resolve(process.argv[6])
const items = JSON.parse(process.argv[7] ?? "[]")
const L = resolve(R, "loops", n)

for (const [letter, label] of items) {
  spawnSync(
    "node",
    [
      integrity,
      `${L}/${letter}-dark.svg`,
      `${L}/${letter}-light.svg`,
      `${L}/${letter}-mark.svg`,
      `${R}/renders/${n}-${letter}.png`,
      `${title} ${letter} ${label}`,
      `${L}/${letter}-mark16.svg`,
      `${L}/${letter}-mark-mono.svg`,
      `${L}/${letter}-dark.svg`,
    ],
    { stdio: "inherit" },
  )
}

spawnSync(
  "node",
  [
    four,
    title,
    `${R}/renders/${n}-four.png`,
    basisLabel,
    basisDark,
    basisLight,
    ...items.map(([letter, label]) => `${letter.toUpperCase()} ${label}|${L}/${letter}-dark.svg|${L}/${letter}-light.svg`),
  ],
  { stdio: "inherit" },
)
