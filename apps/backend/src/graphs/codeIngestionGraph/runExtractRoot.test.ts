import { beforeEach, describe, expect, it, vi } from "vitest"

const extractors = vi.hoisted(() => {
  const names = [
    "identifyAPIClients",
    "identifyAPIs",
    "identifyDatabases",
    "identifyInfrastructure",
    "identifyStreams",
    "identifyServiceDependencies",
    "identifyLibraries",
    "identifyPatterns",
    "extractInstructionUnits",
    "extractDecisions",
    "extractCodeowners",
    "extractConnectorFile",
  ] as const
  return Object.fromEntries(
    names.map((name) => [name, vi.fn(async () => ({}))]),
  ) as Record<(typeof names)[number], ReturnType<typeof vi.fn>>
})

vi.mock("./nodes/identifyAPIClients.js", () => ({
  identifyAPIClients: extractors.identifyAPIClients,
}))
vi.mock("./nodes/identifyAPIs.js", () => ({
  identifyAPIs: extractors.identifyAPIs,
}))
vi.mock("./nodes/identifyDatabases.js", () => ({
  identifyDatabases: extractors.identifyDatabases,
}))
vi.mock("./nodes/identifyInfrastructure.js", () => ({
  identifyInfrastructure: extractors.identifyInfrastructure,
}))
vi.mock("./nodes/identifyStreams.js", () => ({
  identifyStreams: extractors.identifyStreams,
}))
vi.mock("./nodes/identifyServiceDependencies.js", () => ({
  identifyServiceDependencies: extractors.identifyServiceDependencies,
}))
vi.mock("./nodes/identifyLibraries.js", () => ({
  identifyLibraries: extractors.identifyLibraries,
}))
vi.mock("./nodes/identifyPatterns.js", () => ({
  identifyPatterns: extractors.identifyPatterns,
}))
vi.mock("./nodes/extractInstructionUnits.js", () => ({
  extractInstructionUnits: extractors.extractInstructionUnits,
}))
vi.mock("./nodes/extractDecisions.js", () => ({
  extractDecisions: extractors.extractDecisions,
}))
vi.mock("./nodes/extractCodeowners.js", () => ({
  extractCodeowners: extractors.extractCodeowners,
}))
vi.mock("./nodes/connectorExtractors.js", () => ({
  CONNECTOR_EXTRACTORS: [{ extract: extractors.extractConnectorFile }],
}))
vi.mock("./nodes/linkLocatedPaths.js", () => ({
  linkLocatedPaths: () => ({ extractedObjects: [], extractedClaims: [] }),
  resolveReferenceClaims: vi.fn(),
}))

import { runIdentifyPhaseForRoot, stableRootStepId } from "./runExtractRoot.js"
import type { CodeIngestionState } from "./schemas.js"

describe("stableRootStepId", () => {
  it("maps repo root aliases to repo-root", () => {
    expect(stableRootStepId("./")).toBe("repo-root")
    expect(stableRootStepId(".")).toBe("repo-root")
    expect(stableRootStepId("")).toBe("repo-root")
  })

  it("sanitizes nested paths for OW step names", () => {
    expect(stableRootStepId("apps/backend")).toBe("apps_backend")
    expect(stableRootStepId("./packages/foo-bar")).toBe("packages_foo-bar")
  })
})

describe("runIdentifyPhaseForRoot", () => {
  const state = {
    repositoryId: "repo_1",
    orgId: "org_1",
    targetHash: "abc",
  } as CodeIngestionState
  const deterministic = [
    "extractDecisions",
    "extractCodeowners",
    "extractConnectorFile",
  ]
  const called = () =>
    Object.entries(extractors)
      .filter(([, fn]) => fn.mock.calls.length > 0)
      .map(([name]) => name)
      .sort()

  beforeEach(() => vi.clearAllMocks())

  it("runs every extractor by default", async () => {
    await runIdentifyPhaseForRoot(state, "./", {})
    expect(called()).toEqual(Object.keys(extractors).sort())
  })

  it("runs only the deterministic extractors on a deterministic-only run", async () => {
    await runIdentifyPhaseForRoot(state, "./", {}, { deterministicOnly: true })
    expect(called()).toEqual([...deterministic].sort())
  })
})
