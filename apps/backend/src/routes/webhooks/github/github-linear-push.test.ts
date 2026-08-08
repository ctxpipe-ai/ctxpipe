import { beforeEach, describe, expect, it, vi } from "vitest"
import { maybeActivateLinearSyncOnConfigPush } from "./github-linear-push.js"

const mocks = vi.hoisted(() => ({
  applyConfig: vi.fn(),
  findRepository: vi.fn(),
  getConnection: vi.fn(),
  listInstallations: vi.fn(),
  listTargets: vi.fn(),
  loadConfig: vi.fn(),
  markInitialSync: vi.fn(),
  reset: vi.fn(),
  runWorkflow: vi.fn(),
}))

vi.mock("../../../config/env.js", () => ({
  parseEnv: vi.fn(() => ({})),
}))
vi.mock("../../../db/client.js", () => ({
  withOrgDbContext: vi.fn((_orgId: string, run: () => Promise<unknown>) =>
    run(),
  ),
}))
vi.mock("../../../models/github-installation.js", () => ({
  listInstallationsByGithubInstallationId: mocks.listInstallations,
}))
vi.mock("../../../models/repositories.js", () => ({
  findRepositoryByGithubInstallation: mocks.findRepository,
}))
vi.mock("../../../models/linear-connector.js", () => ({
  applyLinearRepoConfig: mocks.applyConfig,
  getLinearConnectionByConnectionId: mocks.getConnection,
  listLinearSyncTargetsWithRepoByRepositoryId: mocks.listTargets,
  markLinearSyncTargetInitialSync: mocks.markInitialSync,
  resetLinearConnectorAfterMissingConfig: mocks.reset,
}))
vi.mock("../../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: mocks.runWorkflow,
}))
vi.mock("../../../openworkflow/workflows/linear-sync-content.js", () => ({
  linearSyncContent: { spec: { name: "linear-sync-content" } },
}))
vi.mock("../../../services/linear/config-from-repo.js", () => ({
  LINEAR_CONFIG_PATH: "linear/config.yaml",
  loadLinearScopeFromRepo: mocks.loadConfig,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listInstallations.mockResolvedValue([
    { id: "con_github", orgId: "org_1" },
  ])
  mocks.findRepository.mockResolvedValue({
    id: "repo_1",
    name: "acme/context",
    githubConnectionId: "con_github",
  })
  mocks.listTargets.mockResolvedValue([
    {
      orgId: "org_1",
      connectionId: "con_linear",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "main",
    },
  ])
  mocks.loadConfig.mockResolvedValue({
    workspaceId: "workspace-1",
    workspaceName: "Acme",
    customerRequests: "limited",
    scopes: [],
  })
  mocks.getConnection.mockResolvedValue({
    id: "con_linear",
    workspaceId: "workspace-1",
  })
})

describe("Linear config push activation", () => {
  it("applies merged scope and starts initial sync on the selected branch", async () => {
    await maybeActivateLinearSyncOnConfigPush({
      installationId: 42,
      githubConnectionId: "con_github",
      repoFullName: "acme/context",
      ref: "refs/heads/main",
      commits: [{ modified: ["linear/config.yaml"] }],
      log: { error: vi.fn() },
    })

    expect(mocks.applyConfig).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "con_linear" }),
    )
    expect(mocks.markInitialSync).toHaveBeenCalledWith("con_linear")
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "linear-sync-content" },
      { orgId: "org_1", connectionId: "con_linear" },
    )
  })

  it("rejects config copied from another Linear workspace", async () => {
    mocks.loadConfig.mockResolvedValue({
      workspaceId: "workspace-other",
      workspaceName: "Other",
      customerRequests: "limited",
      scopes: [],
    })
    const error = vi.fn()

    await maybeActivateLinearSyncOnConfigPush({
      installationId: 42,
      repoFullName: "acme/context",
      ref: "refs/heads/main",
      commits: [{ added: ["linear/config.yaml"] }],
      log: { error },
    })

    expect(mocks.applyConfig).not.toHaveBeenCalled()
    expect(mocks.reset).toHaveBeenCalledWith({
      orgId: "org_1",
      connectionId: "con_linear",
    })
    expect(error).toHaveBeenCalled()
  })
})
