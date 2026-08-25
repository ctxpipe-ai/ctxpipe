import { describe, expect, it } from "vitest"
import { planDestWorkspaceLinks } from "./dest-workspace-assignment.js"

const at = (iso: string) => new Date(iso)

describe("planDestWorkspaceLinks", () => {
  it("links only non-target repos to the first connector-target Workspace", () => {
    const firstTarget = {
      id: "repo_first",
      gitUrl: "https://github.com/acme/docs",
      createdAt: at("2026-01-01T00:00:00.000Z"),
    }
    const secondTarget = {
      id: "repo_second",
      gitUrl: "https://github.com/acme/wiki",
      createdAt: at("2026-02-01T00:00:00.000Z"),
    }
    const ordinary = {
      id: "repo_app",
      gitUrl: "https://github.com/acme/app",
      createdAt: at("2026-03-01T00:00:00.000Z"),
    }
    const firstWorkspace = {
      id: "ws_docs",
      workspaceRepositoryUrl: "https://github.com/acme/docs",
    }
    const secondWorkspace = {
      id: "ws_wiki",
      workspaceRepositoryUrl: "https://github.com/acme/wiki",
    }
    const plan = planDestWorkspaceLinks({
      workspaces: [secondWorkspace, firstWorkspace],
      repositories: [secondTarget, ordinary, firstTarget],
      connectorTargetRepositoryIds: [secondTarget.id, firstTarget.id],
      existingLinks: [
        {
          id: "wlr_wrong_ws",
          workspaceId: secondWorkspace.id,
          gitUrl: ordinary.gitUrl,
        },
        {
          id: "wlr_sibling",
          workspaceId: firstWorkspace.id,
          gitUrl: secondTarget.gitUrl,
        },
        {
          id: "wlr_keep",
          workspaceId: firstWorkspace.id,
          gitUrl: ordinary.gitUrl,
        },
      ],
    })
    expect(plan).toEqual({
      firstWorkspaceId: "ws_docs",
      firstSourceRepositoryId: "repo_first",
      insertLinks: [],
      deleteLinkIds: ["wlr_wrong_ws", "wlr_sibling"],
    })
  })

  it("inserts the missing first-target link and ignores later targets", () => {
    const plan = planDestWorkspaceLinks({
      workspaces: [
        { id: "ws_a", workspaceRepositoryUrl: "https://github.com/acme/a" },
        { id: "ws_b", workspaceRepositoryUrl: "https://github.com/acme/b" },
      ],
      repositories: [
        {
          id: "repo_b",
          gitUrl: "https://github.com/acme/b.git",
          createdAt: at("2026-01-02T00:00:00.000Z"),
        },
        {
          id: "repo_a",
          gitUrl: "https://github.com/acme/a.git",
          createdAt: at("2026-01-01T00:00:00.000Z"),
        },
        {
          id: "repo_lib",
          gitUrl: "https://github.com/acme/lib",
          createdAt: at("2026-01-03T00:00:00.000Z"),
        },
      ],
      connectorTargetRepositoryIds: ["repo_b", "repo_a"],
      existingLinks: [],
    })
    expect(plan.firstWorkspaceId).toBe("ws_a")
    expect(plan.firstSourceRepositoryId).toBe("repo_a")
    expect(plan.insertLinks).toEqual([
      { workspaceId: "ws_a", gitUrl: "https://github.com/acme/lib" },
    ])
    expect(plan.deleteLinkIds).toEqual([])
  })
})
