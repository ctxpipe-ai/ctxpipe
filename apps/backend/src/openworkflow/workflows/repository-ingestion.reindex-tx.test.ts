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

const reindexMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    indexedAt: "2026-01-01T00:00:00.000Z",
    targetHash: "abc",
    ingestMode: "full" as const,
    changedPaths: [],
    deletedPaths: [],
    renames: [],
  }),
)

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

vi.mock("../../observability/langfuse.js", () => ({
  runWithLangfuseContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getLangfuseHandler: () => undefined,
}))

vi.mock("../../graphs/codeIngestionGraph/nodes/reindex.js", () => ({
  reindex: reindexMock,
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

vi.mock("../../graphs/codeIngestionGraph/graph.js", () => ({
  graph: { invoke: vi.fn().mockResolvedValue({}) },
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
      }
    }) => Promise<unknown>,
  ) => ({
    run: handler,
    spec: { name: "repository-ingestion" },
  }),
}))

import { repositoryIngestion } from "./repository-ingestion.js"

describe("repository-ingestion reindex transaction boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls reindex outside withOrgDbContext and caps reindex retries", async () => {
    let reindexRetryPolicy: { maximumAttempts?: number } | undefined
    let withOrgCallsDuringReindex = 0

    const step = {
      run: async (
        opts: { name: string; retryPolicy?: { maximumAttempts?: number } },
        fn: () => unknown,
      ) => {
        if (opts.name === "reindexStep") {
          reindexRetryPolicy = opts.retryPolicy
          const before = withOrgDbContextMock.mock.calls.length
          const result = await fn()
          withOrgCallsDuringReindex =
            withOrgDbContextMock.mock.calls.length - before
          return result
        }
        return fn()
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

    expect(reindexMock).toHaveBeenCalledOnce()
    expect(withOrgCallsDuringReindex).toBe(0)
    expect(reindexRetryPolicy?.maximumAttempts).toBe(2)
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
