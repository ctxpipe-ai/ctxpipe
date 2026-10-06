import { expect, it } from "vitest"
import { partialRetractionPaths, workspaceExtractionSchema } from "./extraction.js"

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
