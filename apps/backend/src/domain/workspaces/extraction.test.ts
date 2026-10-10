import { expect, it } from "vitest"
import {
  extractionRetraction,
  partialRetractionPaths,
  workspaceExtractionSchema,
} from "./extraction.js"

it("lists each changed, deleted, and renamed path of a partial ingest once", () => {
  expect(
    partialRetractionPaths({
      changedPaths: ["src/a.ts", "src/b.ts"],
      deletedPaths: ["src/c.ts", "src/a.ts"],
      renames: [{ from: "src/d.ts", to: "src/e.ts" }],
    }),
  ).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"])
})

it("falls back to a full ingest before the model calls when a partial change set is too large for the command", () => {
  const changedPaths = Array.from({ length: 100_001 }, (_, i) => `src/${i}.ts`)
  expect(partialRetractionPaths({ changedPaths })).toBeNull()
  // The queued command, parsed after extraction, rejects the same list.
  expect(
    workspaceExtractionSchema.safeParse({
      repositoryId: "repo_fixture",
      repositoryUrl: "https://github.com/fixture/source",
      sourceSha: "a".repeat(40),
      retraction: {
        mode: "partial",
        observedAt: new Date(0).toISOString(),
        paths: changedPaths,
      },
      capture: { scope: "full", extractorVersion: 1, roots: ["."] },
    }).success,
  ).toBe(false)
})

it("retracts nothing when the extractors skipped files after a model error", () => {
  const observedAt = new Date(0).toISOString()
  expect(
    extractionRetraction({ partialPaths: null, observedAt, skippedFiles: 0 }),
  ).toEqual({ mode: "full", observedAt })
  expect(
    extractionRetraction({
      partialPaths: ["src/a.ts"],
      observedAt,
      skippedFiles: 0,
    }),
  ).toEqual({ mode: "partial", observedAt, paths: ["src/a.ts"] })
  // The facts of a skipped file are not in the capture; a retraction would expire them.
  for (const partialPaths of [null, ["src/a.ts"]])
    expect(
      extractionRetraction({ partialPaths, observedAt, skippedFiles: 1 }),
    ).toBeUndefined()
})
