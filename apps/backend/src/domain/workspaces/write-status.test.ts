import { describe, expect, it } from "vitest"
import {
  classifyWorkspaceWriteHost,
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

  it("leaves GitHub with a connection unknown until a live probe", () => {
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
  })
})

describe("probeWorkspaceWriteAccess", () => {
  it("skips GitHub when classification already decided", async () => {
    const getRepo = async () => {
      throw new Error("should not call GitHub")
    }
    await expect(
      probeWorkspaceWriteAccess({
        workspaceRepositoryUrl: "https://gitlab.com/acme/docs",
        githubConnectionId: "con_gh",
        getRepo,
      }),
    ).resolves.toMatchObject({
      writeStatus: "read_only",
      defaultBranch: null,
    })
  })

  it("uses the repository default branch and push bit", async () => {
    await expect(
      probeWorkspaceWriteAccess({
        workspaceRepositoryUrl: "https://github.com/acme/docs",
        githubConnectionId: "con_gh",
        getRepo: async (fullName) => {
          expect(fullName).toBe("acme/docs")
          return { defaultBranch: "develop", canPush: true }
        },
      }),
    ).resolves.toEqual({
      writeStatus: "writable",
      readOnlyReason: null,
      defaultBranch: "develop",
    })
  })

  it("maps a 404 from getRepo to not-in-installation", async () => {
    await expect(
      probeWorkspaceWriteAccess({
        workspaceRepositoryUrl: "https://github.com/acme/docs",
        githubConnectionId: "con_gh",
        getRepo: async () => {
          const error = new Error("Not Found") as Error & { status: number }
          error.status = 404
          throw error
        },
      }),
    ).resolves.toMatchObject({
      writeStatus: "read_only",
      readOnlyReason: WRITE_STATUS_REASONS.notInInstallation,
    })
  })
})
