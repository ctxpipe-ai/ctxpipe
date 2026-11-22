#!/usr/bin/env node
// find-stores: the finder of the datasources-infra skill (stores-lib.mjs).
// It lists the data stores and the infrastructure of each root of the map.
// It writes nothing. The skill runs only in the repository-wide step, so the
// script refuses --path.
//
// node find-stores.mjs --source /ctxpipe/source/<handle> --source-url <url> --source-path <path> \
//   --roots <root-to-file map> [--root /ctxpipe] [--count]
//
// With --count, it prints only `{"count": <n>}`: the number of pairs of an id
// and a root (the inputs of the cursor), always of the full list. The host
// runs it before each page and takes the count as the length of the cursor
// (CTX-1487).
//
// Else, like the other finders, it lists only the entries that wait: an
// entry whose pair of an id and a root is done in the tree of the active step
// (`storeCursor`) is not in the list.
// `done` and `waiting` count the pairs. The list ends at the size limit of
// `outputBudget`; then `more` is true. The model writes the plan in parts,
// and the script prints the next entries when it runs again. An entry shows at most 8
// evidence entries; `evidenceTotal` gives the full count, and write-stores.mjs
// reads all of them.

import { scriptStep, stepArgs } from "../../bin/knowledge-lib.mjs"
import { outputBudget } from "../../bin/stage-lib.mjs"
import {
  cursorLength,
  findStores,
  storeCandidates,
  storeCursor,
  refuseRootStep,
} from "./stores-lib.mjs"

const { source, rootsFile, rootPath } = stepArgs()
refuseRootStep(rootPath)
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

// The count needs no context index: `existing` is not in it.
if (process.argv.includes("--count"))
  print({
    count: cursorLength(
      storeCandidates(findStores({ index: [], source, rootsFile })),
    ),
  })
else {
  // A pair waits when the tree of the step has not done it.
  const { step, repository, index, roots: unitRoots } = scriptStep()
  const result = findStores({ index, source, rootsFile })
  const candidates = storeCandidates(result)
  const cursor = storeCursor({
    step,
    repository,
    index,
    roots: unitRoots,
    candidates,
  })
  const waits = new Set(cursor.waiting.map((w) => `${w.id} ${w.root}`))
  const budget = outputBudget()
  const entries = new Map()
  const emptyEntry = (root) => ({
    root,
    stores: [],
    infrastructure: [],
    skipped: [],
  })
  const entryOf = (root) => {
    if (!entries.has(root)) entries.set(root, emptyEntry(root))
    return entries.get(root)
  }
  // The stores and kinds that wait come first, so that a long list of
  // skipped files cannot hide them. A root entry counts in the budget too.
  for (const r of result.roots)
    for (const key of ["stores", "infrastructure"])
      for (const item of r[key]) {
        if (!waits.has(`${item.id} ${r.root}`)) continue
        const shown = { ...item, evidence: item.evidence.slice(0, 8) }
        if (!entries.has(r.root) && !budget.take(emptyEntry(r.root))) continue
        if (budget.take(shown)) entryOf(r.root)[key].push(shown)
      }
  for (const r of result.roots)
    for (const skip of r.skipped) {
      if (!entries.has(r.root) && !budget.take(emptyEntry(r.root))) continue
      if (budget.take(skip)) entryOf(r.root).skipped.push(skip)
    }
  const skipped = result.skipped.filter((skip) => budget.take(skip))
  print({
    done: cursor.at,
    waiting: cursor.of - cursor.at,
    more: budget.more(),
    roots: result.roots
      .map((r) => entries.get(r.root))
      .filter((entry) => entry !== undefined),
    skipped,
  })
}
