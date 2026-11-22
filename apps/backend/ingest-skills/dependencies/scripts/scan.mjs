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

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { scriptStep } from "../../bin/knowledge-lib.mjs"
import { outputBudget, writePatch } from "../../bin/stage-lib.mjs"
import {
  claimGroups,
  scan,
  stepCandidates,
  stepRoots,
  stepStats,
} from "./scan-lib.mjs"

const { step, source, roots, rootPath, index, skipped } = scriptStep()
const scanRoot = (root) =>
  scan({
    source,
    path: root.path,
    otherRoots: roots.map((r) => r.path),
    index,
    own: new Set(root.files.map((f) => f.path)),
  })

// --count: the finder of the cursor (CTX-1487). It prints `{"count": <n>}`,
// the candidates of this step (`stepCandidates`) in each root of the step,
// and writes nothing. apply.mjs counts the candidates that are resolved.
//
// --gate: the host runs this before the model. It prints `needsModel`, true
// when a claim is possible: a candidate of this step, in a root with a Service
// file. The script writes the counts to patch.json. When the model runs and
// does not run apply.mjs, ctxpipe-finish keeps these counts. When
// `needsModel` is false, the host runs no model.
if (process.argv.includes("--count")) {
  const count = stepRoots(roots, rootPath).reduce(
    (sum, root) =>
      sum + stepCandidates(scanRoot(root).candidates, rootPath === null).length,
    0,
  )
  process.stdout.write(`${JSON.stringify({ count })}\n`)
} else if (process.argv.includes("--gate")) {
  const { stats, claimable } = stepStats(roots, rootPath, scanRoot)
  if (!claimable)
    stats[
      stats["roots.no_service"] ? "gate.no_service" : "gate.no_candidates"
    ] = 1
  writePatch(step, { stats })
  process.stdout.write(`${JSON.stringify({ needsModel: claimable })}\n`)
} else {
  // The list holds only the candidates that wait (CTX-1487): the claims do
  // not resolve each candidate of their file (`claimGroups`), and
  // resolutions.json of this page does not name them. It has no count limit. It ends at the size limit of
  // `outputBudget`, so that the model can read it; then `more` is true.
  const repositoryStep = rootPath === null
  let named = []
  try {
    const parsed = JSON.parse(
      readFileSync(join(step.stepDir, "resolutions.json"), "utf8"),
    )
    if (Array.isArray(parsed?.resolutions)) named = parsed.resolutions
  } catch {}
  const listed = new Set(
    named
      .filter((r) => typeof r?.id === "string")
      .map((r) => `${repositoryStep ? r.root : rootPath} ${r.id}`),
  )
  const budget = outputBudget()
  let waiting = 0
  const list = (root) => {
    const result = scanRoot(root)
    const all = stepCandidates(result.candidates, repositoryStep)
    const open = new Set()
    for (const group of claimGroups(step, root, all, repositoryStep))
      if (group.resolved < group.members.length) {
        const left = group.members.filter(
          (c) => !listed.has(`${root.path} ${c.id}`),
        )
        waiting += Math.min(left.length, group.members.length - group.resolved)
        for (const c of left) open.add(c)
      }
    const candidates = all.filter((c) => open.has(c) && budget.take(c))
    return { root: root.path, candidates, skipped: result.skipped }
  }
  const out = stepRoots(roots, rootPath).map(list)
  const more = budget.more()
  if (!repositoryStep) {
    process.stdout.write(
      `${JSON.stringify({
        root: rootPath,
        waiting,
        more,
        candidates: out[0].candidates,
        skipped: [...skipped, ...out[0].skipped],
      })}\n`,
    )
  } else {
    process.stdout.write(
      `${JSON.stringify({ waiting, more, roots: out, skipped })}\n`,
    )
  }
}
