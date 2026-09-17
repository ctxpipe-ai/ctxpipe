/**
 * Guard: every code extractor honours the connector-only short-circuit and
 * every connector extractor keeps the deletes-only guard (ADR-033 §7).
 * Source-text assertions on purpose: a new extractor that forgets the guard
 * fails here before it costs an LLM run on a Linear sync.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it, vi } from "vitest"

const here = fileURLToPath(new URL(".", import.meta.url))
const read = (name: string) => readFileSync(resolve(here, name), "utf8")

const CODE_EXTRACTORS = [
  "extractKind.ts",
  "identifyAPIClients.ts",
  "identifyAPIs.ts",
  "identifyDatabases.ts",
  "identifyInfrastructure.ts",
  "identifyLibraries.ts",
  "identifyPatterns.ts",
  "identifyServiceDependencies.ts",
  "identifyStreams.ts",
  "extractInstructionUnits.ts",
  "extractDecisions.ts",
  "extractCodeowners.ts",
]

const CONNECTOR_EXTRACTORS = [
  "extractGithubPullRequests.ts",
  "extractLinear.ts",
  "extractSlackThreads.ts",
]

describe("extractor guards", () => {
  it("code extractors skip connector-only diffs", () => {
    for (const file of CODE_EXTRACTORS) {
      expect(read(file), file).toContain(
        "shouldSkipCodeExtractorForPartialDiff(",
      )
      expect(read(file), file).not.toContain(
        "shouldSkipExtractorForPartialDeletesOnly(",
      )
    }
  })

  it("connector extractors keep the deletes-only guard and never the code guard", () => {
    for (const file of CONNECTOR_EXTRACTORS) {
      expect(read(file), file).toContain(
        "shouldSkipExtractorForPartialDeletesOnly(",
      )
      expect(read(file), file).not.toContain(
        "shouldSkipCodeExtractorForPartialDiff(",
      )
    }
  })
})

const mocks = vi.hoisted(() => ({ globFiles: vi.fn(), fetchFiles: vi.fn() }))
vi.mock("../../../domain/codeIngestion/codesearchClient.js", () => ({
  globFiles: mocks.globFiles,
  fetchFiles: mocks.fetchFiles,
}))
vi.mock("../setIngestionIndexingStep.js", () => ({
  setIngestionIndexingStep: async () => undefined,
}))

import { extractKind } from "./extractKind.js"

describe("extractKind on a connector-only diff", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns nothing without touching codesearch", async () => {
    const result = await extractKind({
      repositoryId: "repo_ctx",
      orgId: "org_1",
      targetHash: "h",
      roots: ["./"],
      ingestMode: "partial",
      changedPaths: ["github/pulls/acme/api/42--1.md"],
      extractedObjects: [],
      extractedClaims: [],
      objectIds: [],
      touchedObjectIds: [],
      claimsForProjection: [],
    })
    expect(result).toEqual({})
    expect(mocks.globFiles).not.toHaveBeenCalled()
  })
})
