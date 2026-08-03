import { beforeEach, describe, expect, it, vi } from "vitest"

const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn(async (_orgId: string, fn: (db: unknown) => unknown) => {
    const db = {
      query: {
        repositories: {
          findFirst: vi.fn().mockResolvedValue({
            id: "repo_1",
            orgId: "org_1",
            lastIngestedHash: null,
            githubConnectionId: "con_1",
          }),
        },
      },
    }
    return fn(db)
  }),
)

const repositoryIndexResult = {
  indexedAt: "2026-01-01T00:00:00.000Z",
  targetHash: "abc",
  ingestMode: "full" as const,
  changedPaths: [] as string[],
  deletedPaths: [] as string[],
  renames: [] as Array<{ from: string; to: string }>,
}

vi.mock("../../db/client.js", () => ({
  getSystemDb: () => ({
    query: {
      organizations: {
        findFirst: vi.fn().mockResolvedValue({ id: "org_1", slug: "org" }),
      },
    },
  }),
  withOrgDbContext: withOrgDbContextMock,
}))

vi.mock("../../auth/withAuth.js", () => ({
  withOrgIdContext: (_org: unknown, fn: () => unknown) => fn(),
}))

vi.mock("../../observability/logger.js", () => ({
  createLogger: () => ({}),
  withLogger: (_l: unknown, fn: () => unknown) => fn(),
  getLogger: () => ({
    set: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
  flushWorkflowLog: vi.fn(),
}))

vi.mock("../../graphs/codeIngestionGraph/withIngestAgentContext.js", () => ({
  withIngestAgentContext: (_attrs: unknown, fn: () => unknown) => fn(),
}))

vi.mock("../../graphs/codeIngestionGraph/nodes/retractStaleEvidence.js", () => ({
  retractStaleEvidence: vi.fn().mockResolvedValue({
    retractionStats: {},
    retractionGraphEffects: {
      deletedClaimIds: [],
      refreshedClaimIds: [],
      deletedObjectIds: [],
    },
  }),
}))

vi.mock("../../graphs/codeIngestionGraph/nodes/identifyRoots.js", () => ({
  identifyRoots: vi.fn().mockResolvedValue({ roots: [] }),
}))

vi.mock("../../graphs/codeIngestionGraph/runExtractRoot.js", () => ({
  stableRootStepId: (root: string) => root,
  runExtractKindForRoot: vi.fn().mockResolvedValue({}),
  runIdentifyPhaseForRoot: vi.fn().mockResolvedValue({
    extractedObjects: [],
    extractedClaims: [],
  }),
}))

vi.mock("../../graphs/codeIngestionGraph/nodes/deduplicateAndStore.js", () => ({
  deduplicateAndStore: vi.fn().mockResolvedValue({
    objectIds: [],
    touchedObjectIds: [],
    claimsForProjection: [],
  }),
}))

vi.mock("../../graphs/codeIngestionGraph/nodes/project.js", () => ({
  project: vi.fn().mockResolvedValue({}),
}))

vi.mock("../../graphs/codeIngestionGraph/nodes/embed.js", () => ({
  embed: vi.fn().mockResolvedValue({}),
}))

vi.mock("../../domain/codeIngestion/queue.js", () => ({
  resolveRepositoryRef: vi
    .fn()
    .mockResolvedValue({ hash: "abc", branch: "main" }),
}))

vi.mock("../../models/repositories.js", () => ({
  markRepositoryIndexingRunning: vi.fn().mockResolvedValue(undefined),
  markRepositoryIndexingReady: vi.fn().mockResolvedValue(undefined),
  setRepositoryIndexingStep: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../retrieval/services/ingestionRetraction.js", () => ({
  applyIngestionRetractionGraphEffects: vi.fn(),
}))

const enqueueFollowUpIfTipAheadMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ enqueued: false, tipHash: "abc" }),
)

vi.mock("../enqueue-follow-up-if-tip-ahead.js", () => ({
  enqueueFollowUpIfTipAhead: enqueueFollowUpIfTipAheadMock,
}))

vi.mock("./repository-index.js", () => ({
  repositoryIndex: {
    spec: { name: "repository-index" },
  },
}))

vi.mock("openworkflow", () => ({
  defineWorkflow: (
    _opts: unknown,
    handler: (args: {
      input: { repositoryId: string; orgId: string }
      step: {
        run: (
          opts: { name: string; retryPolicy?: unknown },
          fn: () => unknown,
        ) => Promise<unknown>
        runWorkflow: (
          spec: unknown,
          input: unknown,
          opts?: { name?: string },
        ) => Promise<unknown>
      }
    }) => Promise<unknown>,
  ) => ({
    run: handler,
    fn: handler,
    spec: { name: "repository-ingestion" },
  }),
}))

import { repositoryIngestion } from "./repository-ingestion.js"

describe("repository-ingestion index workflow boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("runs repository-index via runWorkflow outside withOrgDbContext", async () => {
    let withOrgCallsDuringIndex = 0
    let ranIndexChild = false

    const step = {
      run: async (
        _opts: { name: string; retryPolicy?: { maximumAttempts?: number } },
        fn: () => unknown,
      ) => fn(),
      runWorkflow: async (
        _spec: unknown,
        _input: unknown,
        _opts?: { name?: string },
      ) => {
        ranIndexChild = true
        const before = withOrgDbContextMock.mock.calls.length
        // Child workflow itself does not use withOrgDbContext for codesearch HTTP.
        withOrgCallsDuringIndex =
          withOrgDbContextMock.mock.calls.length - before
        return repositoryIndexResult
      },
    }

    const wf = repositoryIngestion as unknown as {
      run: (args: {
        input: { repositoryId: string; orgId: string }
        step: typeof step
      }) => Promise<unknown>
    }

    await wf.run({
      input: { repositoryId: "repo_1", orgId: "org_1" },
      step,
    })

    expect(ranIndexChild).toBe(true)
    expect(withOrgCallsDuringIndex).toBe(0)
    expect(enqueueFollowUpIfTipAheadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        repositoryId: "repo_1",
        ingestedHash: "abc",
      }),
      expect.any(Object),
    )
  })
})
