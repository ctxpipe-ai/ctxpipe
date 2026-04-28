import { beforeEach, describe, expect, it, vi } from "vitest"

const resetMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const runWorkflowMock = vi.hoisted(() => vi.fn())

vi.mock("../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))

vi.mock("../../models/confluence-sync-target.js", () => ({
  getConfluenceSyncTargetWithRepoByConnectionId: vi.fn(),
}))

vi.mock("../../openworkflow/client.js", () => ({
  ow: { runWorkflow: runWorkflowMock },
}))

vi.mock("./config-from-repo.js", () => ({
  loadConfluenceScopeFromRepo: vi.fn(),
}))

vi.mock("./confluence-setup-reset.js", () => ({
  resetConfluenceConnectorAfterMissingConfig: resetMock,
}))

import { getConfluenceSyncTargetWithRepoByConnectionId } from "../../models/confluence-sync-target.js"
import { loadConfluenceScopeFromRepo } from "./config-from-repo.js"
import { handleForgeConfluenceContentEvent } from "./forge-confluence-webhook.js"

describe("handleForgeConfluenceContentEvent", () => {
  const env = {} as never

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("resets when Git config is missing or unparsable", async () => {
    vi.mocked(getConfluenceSyncTargetWithRepoByConnectionId).mockResolvedValue({
      enabled: true,
      setupPhase: "live",
      githubConnectionId: "ghc_1",
      repositoryName: "o/r",
      branch: "main",
    } as never)
    vi.mocked(loadConfluenceScopeFromRepo).mockResolvedValue(undefined)

    const result = await handleForgeConfluenceContentEvent({
      orgId: "org_1",
      connectionId: "con_1",
      env,
      spaceKey: "ENG",
    })

    expect(result).toBe("reset")
    expect(resetMock).toHaveBeenCalledWith({
      connectionId: "con_1",
      orgId: "org_1",
    })
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("does not reset when YAML has empty spaces (valid “sync nothing”)", async () => {
    vi.mocked(getConfluenceSyncTargetWithRepoByConnectionId).mockResolvedValue({
      enabled: true,
      setupPhase: "live",
      githubConnectionId: "ghc_1",
      repositoryName: "o/r",
      branch: "main",
    } as never)
    vi.mocked(loadConfluenceScopeFromRepo).mockResolvedValue({ spaces: [] })

    const result = await handleForgeConfluenceContentEvent({
      orgId: "org_1",
      connectionId: "con_1",
      env,
      spaceKey: "ENG",
    })

    expect(result).toBe("skipped")
    expect(resetMock).not.toHaveBeenCalled()
  })
})
