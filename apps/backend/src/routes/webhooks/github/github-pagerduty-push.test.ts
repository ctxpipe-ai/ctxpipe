import { beforeEach, describe, expect, it, vi } from "vitest"
import { maybeActivatePagerdutySyncOnConfigPush } from "./github-pagerduty-push.js"

const mocks = vi.hoisted(() => ({
  compareCommits: vi.fn(),
  findRepository: vi.fn(),
  getConnection: vi.fn(),
  listInstallations: vi.fn(),
  listTargets: vi.fn(),
  loadConfig: vi.fn(),
  markInitialSync: vi.fn(),
  reset: vi.fn(),
  runWorkflow: vi.fn(),
  transitionState: vi.fn(),
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
vi.mock("../../../models/pagerduty-connector.js", () => ({
  getPagerdutyConnectionByConnectionId: mocks.getConnection,
  listPagerdutyBindingsWithRepoByRepositoryId: mocks.listTargets,
  claimPagerdutyBindingInitialSync: mocks.markInitialSync,
  resetPagerdutyConnectorAfterMissingConfig: mocks.reset,
  transitionPagerdutyBindingState: mocks.transitionState,
}))
vi.mock("../../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: mocks.runWorkflow,
}))
vi.mock("../../../openworkflow/workflows/pagerduty-sync-content.js", () => ({
  pagerdutySyncContent: { spec: { name: "pagerduty-sync-content" } },
}))
vi.mock("../../../services/github/installation-write-client.js", () => ({
  compareCommitsTouchesPath: mocks.compareCommits,
}))
vi.mock("../../../services/pagerduty/config-from-repo.js", () => ({
  PAGERDUTY_CONFIG_PATH: "pagerduty/config.yaml",
  loadPagerdutyScopeFromRepo: mocks.loadConfig,
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
      connectionId: "con_pd",
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "main",
    },
  ])
  mocks.loadConfig.mockResolvedValue({
    accountId: "acme",
    services: [],
  })
  mocks.getConnection.mockResolvedValue({
    id: "con_pd",
    accountId: "acme",
  })
  mocks.compareCommits.mockResolvedValue(false)
  mocks.markInitialSync.mockResolvedValue(true)
  mocks.transitionState.mockResolvedValue(true)
})

describe("PagerDuty config push activation", () => {
  it("starts initial sync from merged config on the selected branch", async () => {
    await maybeActivatePagerdutySyncOnConfigPush({
      installationId: 42,
      githubConnectionId: "con_github",
      repoFullName: "acme/context",
      ref: "refs/heads/main",
      commits: [{ modified: ["pagerduty/config.yaml"] }],
      log: { error: vi.fn() },
    })

    expect(mocks.markInitialSync).toHaveBeenCalledWith({
      connectionId: "con_pd",
      repositoryId: "repo_1",
      branch: "main",
    })
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "pagerduty-sync-content" },
      { orgId: "org_1", connectionId: "con_pd" },
    )
  })
})
