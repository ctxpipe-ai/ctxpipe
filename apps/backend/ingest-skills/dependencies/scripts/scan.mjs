#!/usr/bin/env node
// dependencies, step 1: find the candidate dependencies (HTTP calls, queue
// and stream clients, config readers) with the ast-grep rules of this skill.
// No model runs here. The model resolves the candidates to services and
// streams, and apply.mjs writes the files.
//
// node scan.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --roots <root-to-file map> [--path <root path>]
//
// With --path (a root step): the HTTP and config candidates of that root.
// Without --path (the repository-wide step): for each root of the map, the
// candidates that are not HTTP calls. A stream or queue candidate is
// resolved once, in the repository-wide step, because only that step writes
// the Stream files that more than one root can share (ADR-052 section 6).

import { scriptStep } from "../../bin/knowledge-lib.mjs"
import { scan } from "./scan-lib.mjs"

const { source, roots, rootPath, index, skipped } = scriptStep()
const scanRoot = (root) =>
  scan({
    source,
    path: root.path,
    otherRoots: roots.map((r) => r.path),
    index,
    own: new Set(root.files.map((f) => f.path)),
  })

if (rootPath !== null) {
  const current = roots.find((r) => r.path === rootPath) ?? {
    path: rootPath,
    files: [],
  }
  const result = scanRoot(current)
  process.stdout.write(
    `${JSON.stringify({
      root: rootPath,
      ...result,
      candidates: result.candidates.filter(
        (c) => c.type !== "stream" && c.type !== "queue",
      ),
      skipped: [...skipped, ...result.skipped],
    })}\n`,
  )
} else {
  const out = roots.map((root) => {
    const result = scanRoot(root)
    return {
      root: root.path,
      candidates: result.candidates.filter((c) => c.type !== "http"),
      skipped: result.skipped,
      truncated: result.truncated,
    }
  })
  process.stdout.write(`${JSON.stringify({ roots: out, skipped })}\n`)
}
