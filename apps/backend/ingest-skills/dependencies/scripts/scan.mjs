#!/usr/bin/env node
// dependencies, step 1: find the candidate dependencies of one root (HTTP
// calls, queue and stream clients, config readers) with the ast-grep rules
// of this skill. No model runs here. The model resolves the candidates to
// services and streams, and apply.mjs writes the files.
//
// node scan.mjs --source /ctxpipe/source/<handle> --path <root path> \
//   [--roots <root-to-file map>] [--root /ctxpipe]

import { readFileSync } from "node:fs"
import { currentStep, fail, parseArgs } from "../../bin/stage-lib.mjs"
import { safePath } from "../../discover-roots/scripts/roots-lib.mjs"
import { scan } from "./scan-lib.mjs"

const { root, args } = parseArgs()
const value = (name) => {
  const at = args.indexOf(name)
  return at === -1 ? null : (args[at + 1] ?? fail(`Give a value after ${name}`))
}
const source = value("--source") ?? fail("Give --source <checkout>")
const path = value("--path") ?? fail("Give --path <root path>")
if (path !== "." && !safePath(path)) fail(`${path} is not a safe root path`)
const rootsFile = value("--roots")
const roots = rootsFile
  ? (JSON.parse(readFileSync(rootsFile, "utf8")).roots ?? [])
  : []
const step = currentStep(root)
let index = []
try {
  index = JSON.parse(readFileSync(step.indexFile, "utf8")).entries ?? []
} catch {
  index = []
}
const own = new Set(
  (roots.find((r) => r?.path === path)?.files ?? []).filter(
    (f) => typeof f === "string",
  ),
)
const result = scan({
  source,
  path,
  otherRoots: roots.map((r) => r?.path).filter((p) => typeof p === "string"),
  index: Array.isArray(index) ? index : [],
  own,
})
process.stdout.write(`${JSON.stringify({ root: path, ...result })}\n`)
