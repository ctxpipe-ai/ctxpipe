#!/usr/bin/env node
// find-apis: list the HTTP operations that one code root of a source
// repository defines, as JSON that matches ../find.schema.json. It reads only
// tracked files at HEAD. The result is evidence for the model; the model
// groups the operations into APIs and the writer script writes the files.
//
// node find-apis.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --source-path <path> --roots <root-to-file map> \
//   --path <root path> [--count]
//
// The root-to-file map lists each root of the run; the script leaves out the
// files of nested roots.
//
// With --count, it is the finder of the cursor (CTX-1487): it prints
// `{"count": <n>}`, the candidate operations of the root (the operations of
// the specifications and the routes, one for each method and path), and
// writes nothing. write-apis.mjs counts the same candidates that are done.
//
// Else it lists only the operations that wait: an operation that is done at
// the step base or in the staged tree (`doneOperations`) is not in the list.
// The list has no count limit. It ends at the size limit of `outputBudget`,
// so that the model can read it; then `more` is true, and the model runs the
// script again after the writer has written the listed operations.

import { readFileSync } from "node:fs"

import { stepArgs } from "../../bin/knowledge-lib.mjs"
import { currentStep, fail, outputBudget } from "../../bin/stage-lib.mjs"
import {
  candidateOperations,
  discoverApis,
  doneOperations,
  operationKey,
} from "./apis-lib.mjs"

const { root, source, rootsFile, rootPath, repository } = stepArgs()
const codeRoot = rootPath ?? fail("Give --path <root path>")
const listed = JSON.parse(readFileSync(rootsFile, "utf8")).roots
if (!Array.isArray(listed)) fail(`${rootsFile} has no roots list`)
const others = listed.map((r) => r?.path).filter((p) => typeof p === "string")
const found = discoverApis(source, codeRoot, others)
const candidates = candidateOperations(found)
if (process.argv.includes("--count")) {
  process.stdout.write(`${JSON.stringify({ count: candidates.size })}\n`)
} else {
  const { done } = doneOperations(currentStep(root), {
    repository,
    codeRoot,
    candidates,
  })
  const budget = outputBudget()
  /** True for an operation that waits and fits in the output. */
  const take = (item) =>
    !done.has(operationKey(item.method, item.path)) && budget.take(item)
  const specs = found.specs.map((spec) => ({
    ...spec,
    operations: spec.operations.filter(take),
  }))
  const routes = found.routes.filter(take)
  process.stdout.write(
    `${JSON.stringify({
      root: found.root,
      done: done.size,
      waiting: candidates.size - done.size,
      more: budget.more(),
      specs,
      routes,
      skipped: found.skipped,
    })}\n`,
  )
}
