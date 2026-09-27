import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getRepositoryForOrg: vi.fn(),
  getInstallationToken: vi.fn(),
  signUpstreamJwt: vi.fn(),
  tryClaim: vi.fn(),
}))

vi.mock("../auth/upstreamJwt.js", () => ({
  signUpstreamJwt: mocks.signUpstreamJwt,
}))
vi.mock("../config/env.js", () => ({
  parseEnv: vi.fn(() => ({
    AUTH_SECRET: "test-secret-that-is-long-enough",
  })),
}))
vi.mock("../db/client.js", () => ({
  withOrgDbContext: vi.fn((_orgId: string, run: () => Promise<unknown>) =>
    run(),
  ),
}))
vi.mock("../lib/agentToolRuntime.js", () => ({
  codesearchBaseUrl: vi.fn(() => "https://codesearch.test"),
}))
vi.mock("../lib/withTransientHttpRetry.js", () => ({
  withTransientHttpRetry: vi.fn((run: () => Promise<Response>) => run()),
}))
vi.mock("../models/github-installation.js", () => ({
  getInstallationToken: mocks.getInstallationToken,
}))
vi.mock("../models/repositories.js", () => ({
  getRepositoryForOrg: mocks.getRepositoryForOrg,
  markRepositoryIndexingFailed: vi.fn(),
  markRepositoryIndexingReady: vi.fn(),
  tryClaimRepositoryIndexingEnqueue: mocks.tryClaim,
}))
vi.mock("./client.js", () => ({
  runWorkflowWithWorkerWake: vi.fn(),
}))
vi.mock("./enqueue-follow-up-if-tip-ahead.js", () => ({
  enqueueFollowUpIfTipAhead: vi.fn(),
}))
vi.mock("./workflows/repository-ingestion-orchestrator.js", () => ({
  repositoryIngestionOrchestrator: {
    spec: { name: "repository-ingestion-orchestrator" },
  },
}))

import {
  type RepositoryIngestionChildStep,
  runConnectorRepositoryIngestionWorkflow,
} from "./enqueue-repository-ingestion.js"

describe("runConnectorRepositoryIngestionWorkflow logger contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getRepositoryForOrg.mockResolvedValue({
      id: "repo_1",
      githubConnectionId: "con_github",
      lastIngestedHash: "sha_previous",
    })
    mocks.getInstallationToken.mockResolvedValue("github-token")
    mocks.signUpstreamJwt.mockResolvedValue("codesearch-token")
    mocks.tryClaim.mockResolvedValue(true)
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ branch: "main", hash: "sha_current" }),
            { status: 200 },
          ),
        ),
    )
  })

  it("runs outside a pre-existing request or workflow logger context", async () => {
    const step = {
      run: vi.fn(
        async (_options: { name: string }, operation: () => Promise<unknown>) =>
          operation(),
      ),
      runWorkflow: vi.fn().mockResolvedValue(undefined),
      sleep: vi.fn(),
    } as unknown as RepositoryIngestionChildStep

    await expect(
      runConnectorRepositoryIngestionWorkflow(
        step,
        {
          repositoryId: "repo_1",
          orgId: "org_1",
          targetBranch: "main",
          indexingReason: "Syncing connector content",
        },
        { error: vi.fn() },
      ),
    ).resolves.toBeUndefined()

    expect(step.runWorkflow).toHaveBeenCalledWith(
      { name: "repository-ingestion-orchestrator" },
      expect.objectContaining({
        repositoryId: "repo_1",
        orgId: "org_1",
        githubConnectionId: "con_github",
      }),
      { name: "ingest-repo_1" },
    )
  })
})
