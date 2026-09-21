import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findRepository: vi.fn(),
  listBindings: vi.fn(),
  listInstallations: vi.fn(),
  runWorkflow: vi.fn(),
}))

vi.mock("../../../config/env.js", () => ({
  parseEnv: vi.fn(() => ({})),
}))
vi.mock("../../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, handler: () => Promise<unknown>) =>
    handler(),
}))
vi.mock("../../../models/github-installation.js", () => ({
  listInstallationsByGithubInstallationId: mocks.listInstallations,
}))
vi.mock("../../../models/github-pr-mirror.js", () => ({
  listGithubPrMirrorBindingsForRepository: mocks.listBindings,
}))
vi.mock("../../../models/repositories.js", () => ({
  findRepositoryByGithubInstallation: mocks.findRepository,
}))
vi.mock("../../../observability/logger.js", () => ({
  getLogger: () => ({ error: vi.fn() }),
}))
vi.mock("../../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: mocks.runWorkflow,
}))
vi.mock("../../../openworkflow/workflows/github-sync-content.js", () => ({
  githubSyncContent: { spec: "github-sync-content" },
  githubPrMirrorContentIdempotencyKey: ({
    connectionId,
    commitSha,
  }: {
    connectionId: string
    commitSha: string
  }) => `github-pr-mirror-content:${connectionId}:${commitSha}`,
}))

import { maybeActivateGithubPrMirrorOnConfigPush } from "./github-pr-mirror-push.js"

describe("maybeActivateGithubPrMirrorOnConfigPush", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listInstallations.mockResolvedValue([
      { id: "con_github", orgId: "org_1" },
    ])
    mocks.findRepository.mockResolvedValue({
      id: "repo_ctx",
      name: "acme/context",
      githubConnectionId: "con_github",
    })
    mocks.listBindings.mockResolvedValue([
      {
        orgId: "org_1",
        connectionId: "con_github",
        branch: "main",
      },
    ])
    mocks.runWorkflow.mockResolvedValue({ workflowRun: { id: "wr_1" } })
  })

  it("keys the content sync by the pushed config commit", async () => {
    await maybeActivateGithubPrMirrorOnConfigPush({
      installationId: 42,
      githubConnectionId: "con_github",
      repoFullName: "acme/context",
      ref: "refs/heads/main",
      commits: [{ modified: ["github/config.yaml"] }],
      before: "sha_before",
      after: "sha_config",
    })

    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      "github-sync-content",
      { orgId: "org_1", connectionId: "con_github" },
      {
        idempotencyKey: "github-pr-mirror-content:con_github:sha_config",
      },
    )
  })

  it("skips a malformed config push without a commit identity", async () => {
    await maybeActivateGithubPrMirrorOnConfigPush({
      installationId: 42,
      githubConnectionId: "con_github",
      repoFullName: "acme/context",
      ref: "refs/heads/main",
      commits: [{ modified: ["github/config.yaml"] }],
    })

    expect(mocks.runWorkflow).not.toHaveBeenCalled()
  })
})
