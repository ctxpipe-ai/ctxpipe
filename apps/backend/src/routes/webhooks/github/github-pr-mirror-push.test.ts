import { createLogger } from "evlog"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { withLogger } from "../../../observability/logger.js"

const mocks = vi.hoisted(() => ({
  findRepository: vi.fn(),
  listBindings: vi.fn(),
  listInstallations: vi.fn(),
  runWorkflow: vi.fn(),
  patch: vi.fn(),
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
  patchGithubPrMirror: mocks.patch,
}))
vi.mock("../../../models/repositories.js", () => ({
  findRepositoryByGithubInstallation: mocks.findRepository,
}))
vi.mock("../../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: mocks.runWorkflow,
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
    mocks.runWorkflow.mockResolvedValue({
      workflowRun: { id: "wr_1", status: "pending" },
    })
    mocks.patch.mockResolvedValue({ applied: true, contentSyncGeneration: 1 })
  })

  it("keys the content sync by the pushed config commit", async () => {
    await withLogger(createLogger(), () =>
      maybeActivateGithubPrMirrorOnConfigPush({
        installationId: 42,
        githubConnectionId: "con_github",
        repoFullName: "acme/context",
        ref: "refs/heads/main",
        commits: [{ modified: ["github/config.yaml"] }],
        before: "sha_before",
        after: "sha_config",
      }),
    )

    expect(mocks.patch).toHaveBeenCalledWith({
      orgId: "org_1",
      connectionId: "con_github",
      reserveContentLaunch: true,
      patch: {
        lastContentCommitSha: "sha_config",
        lastContentLaunchToken: null,
      },
    })
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ name: "github-sync-content" }),
      {
        orgId: "org_1",
        connectionId: "con_github",
        contentSyncGeneration: 1,
        commitSha: "sha_config",
      },
      {
        idempotencyKey: "github-pr-mirror-content:con_github:sha_config",
      },
    )
  })

  it("skips a malformed config push without a commit identity", async () => {
    await withLogger(createLogger(), () =>
      maybeActivateGithubPrMirrorOnConfigPush({
        installationId: 42,
        githubConnectionId: "con_github",
        repoFullName: "acme/context",
        ref: "refs/heads/main",
        commits: [{ modified: ["github/config.yaml"] }],
      }),
    )

    expect(mocks.runWorkflow).not.toHaveBeenCalled()
    expect(mocks.patch).not.toHaveBeenCalled()
  })
})
