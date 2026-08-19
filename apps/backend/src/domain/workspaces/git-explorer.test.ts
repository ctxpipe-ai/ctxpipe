import { describe, expect, it } from "vitest"
import {
  explorerBlobFromContent,
  explorerBlobFromGitFile,
  explorerBlobPath,
  explorerGitNumstatFromStdout,
  explorerGitStatusFromPorcelain,
  withExplorerGitLineCounts,
  workspaceGitExplorerTarget,
} from "./git-explorer.js"
import { WRITE_STATUS_REASONS } from "./write-status.js"

describe("workspaceGitExplorerTarget", () => {
  it("prefers the active projection SHA over desired", () => {
    const result = workspaceGitExplorerTarget({
      workspaceRepositoryUrl: "https://github.com/acme/docs",
      activeProjectionUrl: "https://github.com/acme/docs",
      githubConnectionId: "con_1",
      activeProjectionSha: "active",
      desiredSha: "desired",
    })
    expect(result).toEqual({
      ok: true,
      target: {
        sha: "active",
        repositoryName: "acme/docs",
        githubConnectionId: "con_1",
      },
    })
  })

  it("reads the active SHA from the active projection remote during relink", () => {
    const result = workspaceGitExplorerTarget({
      workspaceRepositoryUrl: "https://github.com/acme/desired",
      activeProjectionUrl: "https://github.com/acme/active",
      githubConnectionId: "con_1",
      activeProjectionSha: "active-sha",
      desiredSha: "desired-sha",
    })
    expect(result).toEqual({
      ok: true,
      target: {
        sha: "active-sha",
        repositoryName: "acme/active",
        githubConnectionId: "con_1",
      },
    })
  })

  it("falls back to desired SHA when the projection is not ready", () => {
    const result = workspaceGitExplorerTarget({
      workspaceRepositoryUrl: "https://github.com/acme/docs.git",
      activeProjectionUrl: null,
      githubConnectionId: "con_1",
      activeProjectionSha: null,
      desiredSha: "  desired  ",
    })
    expect(result).toEqual({
      ok: true,
      target: {
        sha: "desired",
        repositoryName: "acme/docs",
        githubConnectionId: "con_1",
      },
    })
  })

  it("rejects a non-GitHub remote", () => {
    expect(
      workspaceGitExplorerTarget({
        workspaceRepositoryUrl: "https://gitlab.com/acme/docs",
        activeProjectionUrl: null,
        githubConnectionId: "con_1",
        activeProjectionSha: "abc",
        desiredSha: "abc",
      }),
    ).toEqual({
      ok: false,
      status: 409,
      error: WRITE_STATUS_REASONS.nonGithubHost,
    })
  })

  it("rejects a GitHub remote with no App connection", () => {
    expect(
      workspaceGitExplorerTarget({
        workspaceRepositoryUrl: "https://github.com/acme/docs",
        activeProjectionUrl: null,
        githubConnectionId: null,
        activeProjectionSha: "abc",
        desiredSha: "abc",
      }),
    ).toEqual({
      ok: false,
      status: 409,
      error: WRITE_STATUS_REASONS.githubNotConnected,
    })
  })

  it("rejects when no git SHA is stored yet", () => {
    expect(
      workspaceGitExplorerTarget({
        workspaceRepositoryUrl: "https://github.com/acme/docs",
        activeProjectionUrl: null,
        githubConnectionId: "con_1",
        activeProjectionSha: "  ",
        desiredSha: null,
      }),
    ).toEqual({
      ok: false,
      status: 409,
      error: "This Workspace has no git SHA to browse yet.",
    })
  })
})

describe("explorerBlobPath", () => {
  it("accepts a repo-relative path", () => {
    expect(explorerBlobPath("knowledge/billing/ledger.md")).toBe(
      "knowledge/billing/ledger.md",
    )
  })

  it("rejects traversal and absolute paths", () => {
    expect(explorerBlobPath("../secret")).toBeNull()
    expect(explorerBlobPath("/etc/passwd")).toBeNull()
    expect(explorerBlobPath("foo/../bar")).toBeNull()
    expect(explorerBlobPath("")).toBeNull()
    expect(explorerBlobPath("foo//bar")).toBeNull()
  })
})

describe("explorerGitStatusFromPorcelain", () => {
  it("maps porcelain codes onto Pierre git statuses", () => {
    expect(
      explorerGitStatusFromPorcelain(
        [
          "A  knowledge/new.md",
          " M knowledge/ledger.md",
          "D  knowledge/gone.md",
          "R  knowledge/old.md -> knowledge/renamed.md",
          "?? scratch.ts",
          "!! build/out.js",
        ].join("\n"),
      ),
    ).toEqual([
      { path: "knowledge/new.md", status: "added" },
      { path: "knowledge/ledger.md", status: "modified" },
      { path: "knowledge/gone.md", status: "deleted" },
      { path: "knowledge/renamed.md", status: "renamed" },
      { path: "scratch.ts", status: "untracked" },
      { path: "build/out.js", status: "ignored" },
    ])
  })

  it("skips empty and traversal paths", () => {
    expect(
      explorerGitStatusFromPorcelain(" M ../secret\n?? \n M knowledge/ok.md"),
    ).toEqual([{ path: "knowledge/ok.md", status: "modified" }])
  })
})

describe("explorerGitNumstatFromStdout", () => {
  it("parses added and deleted line counts", () => {
    const counts = explorerGitNumstatFromStdout(
      [
        "3\t1\tknowledge/ledger.md",
        "-\t-\tassets/logo.png",
        "0\t4\tknowledge/gone.md",
      ].join("\n"),
    )
    expect(counts.get("knowledge/ledger.md")).toEqual({
      additions: 3,
      deletions: 1,
    })
    expect(counts.get("assets/logo.png")).toEqual({
      additions: 0,
      deletions: 0,
    })
    expect(counts.get("knowledge/gone.md")).toEqual({
      additions: 0,
      deletions: 4,
    })
  })
})

describe("withExplorerGitLineCounts", () => {
  it("counts untracked file lines as additions", () => {
    expect(
      withExplorerGitLineCounts(
        { path: "scratch.ts", status: "untracked" },
        new Map(),
        "export {}\n",
      ),
    ).toEqual({
      path: "scratch.ts",
      status: "untracked",
      additions: 1,
      deletions: 0,
    })
  })
})

describe("explorerBlobFromContent", () => {
  it("returns utf-8 text", () => {
    expect(explorerBlobFromContent("# Ledger")).toEqual({
      body: "# Ledger",
      binary: false,
    })
  })

  it("marks NUL bytes as binary", () => {
    expect(explorerBlobFromContent("png\0data")).toEqual({
      body: null,
      binary: true,
    })
  })

  it("returns null when GitHub has no blob", () => {
    expect(explorerBlobFromContent(undefined)).toBeNull()
  })
})

describe("explorerBlobFromGitFile", () => {
  it("marks omitted GitHub content as binary", () => {
    expect(explorerBlobFromGitFile({ kind: "omitted" })).toEqual({
      body: null,
      binary: true,
    })
  })

  it("marks non-UTF-8 bytes as binary even without a NUL", () => {
    expect(
      explorerBlobFromGitFile({
        kind: "bytes",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      }),
    ).toEqual({ body: null, binary: true })
  })

  it("returns null when the blob is missing", () => {
    expect(explorerBlobFromGitFile({ kind: "missing" })).toBeNull()
  })
})
