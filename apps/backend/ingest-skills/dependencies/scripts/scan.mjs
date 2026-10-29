#!/usr/bin/env node
// dependencies, step 1: find the candidate dependencies (HTTP calls, queue
// and stream clients, config readers) with the ast-grep rules of this skill.
// No model runs here. The model resolves the candidates to services and
// streams, and apply.mjs writes the files.
//
// node scan.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --source-path <path> --roots <root-to-file map> [--path <root path>]
//
// With --path (a root step): the HTTP and config candidates of that root.
// Without --path (the repository-wide step): for each root of the map, the
// candidates that are not HTTP calls. A stream or queue candidate is
// resolved once, in the repository-wide step, because only that step writes
// the Stream files that more than one root can share (ADR-052 section 6).

import { scriptStep } from "../../bin/knowledge-lib.mjs"
import { writePatch } from "../../bin/stage-lib.mjs"
import { addIndexedServices } from "./root-services.mjs"
import { scan, stepCandidates } from "./scan-lib.mjs"

const {
  step,
  source,
  sourcePath,
  repository,
  roots,
  rootPath,
  index,
  skipped,
} = scriptStep()
addIndexedServices({ roots, source, sourcePath, repository, index })
const scanRoot = (root) =>
  scan({
    source,
    path: root.path,
    otherRoots: roots.map((r) => r.path),
    index,
    own: new Set(root.files.map((f) => f.path)),
  })

// --gate: the host runs this before the model. It prints `needsModel`, true
// when a claim is possible: a candidate of this step, in a root with a Service
// file. When it is false, the script writes patch.json with the counts, and
// the host runs no model.
if (process.argv.includes("--gate")) {
  const stats = {}
  const count = (name) => {
    stats[name] = (stats[name] ?? 0) + 1
  }
  let needsModel = false
  for (const root of rootPath === null
    ? roots
    : roots.filter((r) => r.path === rootPath)) {
    const mine = stepCandidates(scanRoot(root).candidates, rootPath === null)
    for (const candidate of mine) count(`candidates.${candidate.type}`)
    if (!mine.length) continue
    if (root.files.some((f) => f.kind === "Service")) needsModel = true
    else count("roots.no_service")
  }
  if (!needsModel) {
    count(stats["roots.no_service"] ? "gate.no_service" : "gate.no_candidates")
    writePatch(step, { stats })
  }
  process.stdout.write(`${JSON.stringify({ needsModel })}\n`)
} else if (rootPath !== null) {
  const current = roots.find((r) => r.path === rootPath) ?? {
    path: rootPath,
    files: [],
  }
  const result = scanRoot(current)
  process.stdout.write(
    `${JSON.stringify({
      root: rootPath,
      ...result,
      candidates: stepCandidates(result.candidates, false),
      skipped: [...skipped, ...result.skipped],
    })}\n`,
  )
} else {
  const out = roots.map((root) => {
    const result = scanRoot(root)
    return {
      root: root.path,
      candidates: stepCandidates(result.candidates, true),
      skipped: result.skipped,
      truncated: result.truncated,
    }
  })
  process.stdout.write(`${JSON.stringify({ roots: out, skipped })}\n`)
}
