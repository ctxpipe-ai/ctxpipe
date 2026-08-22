import { beforeEach, describe, expect, it, vi } from "vitest"

const getGithubInstallationByConnectionIdMock = vi.hoisted(() => vi.fn())
const resolveGithubInstallationForOrgDetailedMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/github-installation.js", () => ({
  getGithubInstallationByConnectionId: getGithubInstallationByConnectionIdMock,
  resolveGithubInstallationForOrgDetailed:
    resolveGithubInstallationForOrgDetailedMock,
}))

import { resolveWorkspaceGithubConnectionId } from "./bind-github-connection.js"

describe("resolveWorkspaceGithubConnectionId", () => {
  beforeEach(() => {
    getGithubInstallationByConnectionIdMock.mockReset()
    resolveGithubInstallationForOrgDetailedMock.mockReset()
  })

  it("keeps a connection that belongs to the org", async () => {
    getGithubInstallationByConnectionIdMock.mockResolvedValue({
      id: "con_gh",
    })
    await expect(
      resolveWorkspaceGithubConnectionId({
        orgId: "org_1",
        requested: "con_gh",
        source: "select",
      }),
    ).resolves.toBe("con_gh")
    expect(resolveGithubInstallationForOrgDetailedMock).not.toHaveBeenCalled()
  })

  it("drops a connection that is not in the org", async () => {
    getGithubInstallationByConnectionIdMock.mockResolvedValue(undefined)
    await expect(
      resolveWorkspaceGithubConnectionId({
        orgId: "org_1",
        requested: "con_other",
      }),
    ).resolves.toBeNull()
  })

  it("uses the org's only GitHub connection when Select omitted an id", async () => {
    resolveGithubInstallationForOrgDetailedMock.mockResolvedValue({
      status: "ok",
      installation: { id: "con_only" },
    })
    await expect(
      resolveWorkspaceGithubConnectionId({
        orgId: "org_1",
        requested: null,
        source: "select",
      }),
    ).resolves.toBe("con_only")
  })

  it("does not infer a connection for Paste", async () => {
    await expect(
      resolveWorkspaceGithubConnectionId({
        orgId: "org_1",
        requested: undefined,
        source: "paste",
      }),
    ).resolves.toBeNull()
    expect(resolveGithubInstallationForOrgDetailedMock).not.toHaveBeenCalled()
  })
})
