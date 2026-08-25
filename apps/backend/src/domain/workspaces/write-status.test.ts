import { describe, expect, it } from "vitest"
import {
  classifyWorkspaceWriteHost,
  githubConnectionIdForWriteProbe,
  githubInstallationCanPush,
  githubRepoFullNameFromWorkspaceUrl,
  probeWorkspaceWriteAccess,
  WRITE_STATUS_REASONS,
  writeStatusFromClassification,
  writeStatusFromGithubProbeError,
} from "./write-status.js"

describe("githubRepoFullNameFromWorkspaceUrl", () => {
  it("parses https and ssh GitHub URLs", () => {
    expect(
      githubRepoFullNameFromWorkspaceUrl(
        "https://github.com/acme/knowledge.git",
      ),
    ).toBe("acme/knowledge")
    expect(
      githubRepoFullNameFromWorkspaceUrl("git@github.com:acme/knowledge.git"),
    ).toBe("acme/knowledge")
  })

  it("returns null for other hosts", () => {
    expect(
      githubRepoFullNameFromWorkspaceUrl("https://gitlab.com/acme/knowledge"),
    ).toBeNull()
  })
})

describe("writeStatusFromClassification", () => {
  it("marks non-GitHub remotes read-only", () => {
    expect(
      writeStatusFromClassification({
        workspaceRepositoryUrl: "https://gitlab.com/example/knowledge",
        githubConnectionId: "con_1",
      }),
    ).toEqual({
      writeStatus: "read_only",
      readOnlyReason: WRITE_STATUS_REASONS.nonGithubHost,
    })
    expect(
      classifyWorkspaceWriteHost("https://gitlab.com/example/knowledge"),
    ).toBe("other")
  })

  it("marks GitHub without an installation connection read-only", () => {
    expect(
      writeStatusFromClassification({
        workspaceRepositoryUrl: "https://github.com/acme/docs",
        githubConnectionId: null,
      }),
    ).toEqual({
      writeStatus: "read_only",
      readOnlyReason: WRITE_STATUS_REASONS.githubNotConnected,
    })
  })

  it("marks GitHub with a connection unknown until a live probe", () => {
    expect(
      writeStatusFromClassification({
        workspaceRepositoryUrl: "https://github.com/acme/docs",
        githubConnectionId: "con_gh",
      }),
    ).toEqual({ writeStatus: "unknown", readOnlyReason: null })
  })
})

describe("writeStatusFromGithubProbeError", () => {
  it("maps 404 to not-in-installation", () => {
    expect(writeStatusFromGithubProbeError({ status: 404 })).toEqual({
      writeStatus: "read_only",
      readOnlyReason: WRITE_STATUS_REASONS.notInInstallation,
    })
  })

  it("maps protected-branch 403 separately from Contents:write", () => {
    expect(
      writeStatusFromGithubProbeError({
        status: 403,
        message: "Required status checks on protected branch",
      }).readOnlyReason,
    ).toBe(WRITE_STATUS_REASONS.protectedBranch)
    expect(
      writeStatusFromGithubProbeError({ status: 403 }).readOnlyReason,
    ).toBe(WRITE_STATUS_REASONS.contentsWriteDenied)
    expect(
      writeStatusFromGithubProbeError({
        status: 403,
        message: "Repository ruleset prevents this push",
      }).readOnlyReason,
    ).toBe(WRITE_STATUS_REASONS.protectedBranch)
  })
})

describe("githubInstallationCanPush", () => {
  it("treats GitHub App contents:write as push, not only the user push bit", () => {
    expect(githubInstallationCanPush({ contents: "write" })).toBe(true)
    expect(githubInstallationCanPush({ contents: "admin" })).toBe(true)
    expect(githubInstallationCanPush({ push: true })).toBe(true)
    expect(githubInstallationCanPush({ admin: true })).toBe(true)
    expect(githubInstallationCanPush({ maintain: true })).toBe(true)
    expect(githubInstallationCanPush({ contents: "read", pull: true })).toBe(
      false,
    )
    expect(githubInstallationCanPush({ push: false, pull: true })).toBe(false)
    expect(githubInstallationCanPush(undefined)).toBe(false)
  })
})

describe("githubConnectionIdForWriteProbe", () => {
  it("reuses the existing connection when the request omits one", () => {
    expect(
      githubConnectionIdForWriteProbe({
        requested: undefined,
        existing: "con_gh",
      }),
    ).toBe("con_gh")
    expect(
      githubConnectionIdForWriteProbe({
        requested: null,
        existing: "con_gh",
      }),
    ).toBeNull()
  })
})

describe("probeWorkspaceWriteAccess", () => {
  it("stays unknown on GitHub until a permission reader runs", async () => {
    await expect(
      probeWorkspaceWriteAccess({
        workspaceRepositoryUrl: "https://gitlab.com/acme/docs",
        githubConnectionId: "con_gh",
      }),
    ).resolves.toMatchObject({
      writeStatus: "read_only",
      defaultBranch: null,
    })
    await expect(
      probeWorkspaceWriteAccess({
        workspaceRepositoryUrl: "https://github.com/acme/docs",
        githubConnectionId: "con_gh",
      }),
    ).resolves.toEqual({
      writeStatus: "unknown",
      readOnlyReason: null,
      defaultBranch: null,
    })
    await expect(
      probeWorkspaceWriteAccess({
        workspaceRepositoryUrl: "https://github.com/acme/docs",
        githubConnectionId: null,
      }),
    ).resolves.toMatchObject({
      writeStatus: "read_only",
      readOnlyReason: WRITE_STATUS_REASONS.githubNotConnected,
    })
  })

  it("uses the GitHub permission reader when provided", async () => {
    const fetchWriteView = async () => ({
      defaultBranch: "main",
      canPush: true,
    })
    await expect(
      probeWorkspaceWriteAccess({
        workspaceRepositoryUrl: "https://github.com/acme/docs",
        githubConnectionId: "con_gh",
        orgId: "org_1",
        fetchWriteView,
      }),
    ).resolves.toEqual({
      writeStatus: "writable",
      readOnlyReason: null,
      defaultBranch: "main",
    })
    await expect(
      probeWorkspaceWriteAccess({
        workspaceRepositoryUrl: "https://github.com/acme/docs",
        githubConnectionId: "con_gh",
        orgId: "org_1",
        fetchWriteView: async () => ({
          defaultBranch: "main",
          canPush: false,
        }),
      }),
    ).resolves.toEqual({
      writeStatus: "read_only",
      readOnlyReason: WRITE_STATUS_REASONS.contentsWriteDenied,
      defaultBranch: "main",
    })
  })
})
