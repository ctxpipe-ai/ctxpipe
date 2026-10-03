import { expect, it } from "vitest"
import { indexingOutcome } from "./indexing-outcome.js"

it("publishes a complete index as ready", () => {
  expect(indexingOutcome({ searchIndexOk: true, scipIndexOk: true })).toEqual({
    kind: "ready",
  })
})

it("publishes an incomplete SCIP index with its issue", () => {
  expect(
    indexingOutcome({
      searchIndexOk: true,
      scipIndexOk: false,
      scipIndexError:
        "TypeScript code intelligence is incomplete: 1 of 6 projects could not be indexed (packages/broken)",
    }),
  ).toEqual({
    kind: "ready-with-issues",
    error:
      "TypeScript code intelligence is incomplete: 1 of 6 projects could not be indexed (packages/broken)",
  })
})

it("keeps the previous revision when search failed and reports both issues", () => {
  expect(
    indexingOutcome({
      searchIndexOk: false,
      searchIndexError: "Codebase didn't fit available memory",
      scipIndexOk: false,
    }),
  ).toEqual({
    kind: "issues",
    error: "Codebase didn't fit available memory; SCIP index unavailable",
  })
})
