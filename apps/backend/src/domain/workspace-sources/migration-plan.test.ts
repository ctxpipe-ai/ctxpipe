import { describe, expect, it } from "vitest"
import { planSourceMigration } from "./migration-plan.js"

const workspace = (
  id: string,
  sourcesFile: string | null = null,
  githubConnectionId: string | null = "con_gh1",
) => ({
  id,
  workspaceRepositoryUrl: `https://github.com/acme/${id}.git`,
  githubConnectionId,
  sourcesFile,
})

describe("planSourceMigration", () => {
  it("maps each connection to every Workspace that uses or links its sync repository", () => {
    const { changes, report } = planSourceMigration({
      workspaces: [workspace("context"), workspace("eng"), workspace("hr")],
      linked: [
        { workspaceId: "eng", gitUrl: "https://github.com/acme/context" },
        { workspaceId: "eng", gitUrl: "https://github.com/acme/api.git" },
      ],
      bindings: [
        {
          provider: "linear",
          connectionId: "con_lin1",
          syncRepositoryUrl: "https://github.com/acme/context.git",
          scope: { teams: ["ENG"] },
        },
        {
          provider: "notion",
          connectionId: "con_not1",
          syncRepositoryUrl: "https://github.com/acme/gone.git",
          scope: {},
        },
        { provider: "slack", connectionId: "con_sl1", unmapped: "No channels" },
      ],
    })
    expect(changes.get("context")).toEqual([
      {
        action: "add",
        provider: "linear",
        connectionId: "con_lin1",
        scope: { teams: ["ENG"] },
      },
    ])
    expect(changes.get("eng")).toEqual([
      {
        action: "add",
        provider: "linear",
        connectionId: "con_lin1",
        scope: { teams: ["ENG"] },
      },
      {
        action: "add",
        sourceKey: "linked-repositories",
        provider: "github",
        connectionId: "con_gh1",
        scope: { repositories: ["acme/api", "acme/context"] },
      },
    ])
    expect(changes.has("hr")).toBe(false)
    expect(report.unmapped.map((item) => item.connectionId)).toEqual([
      "con_not1",
      "con_sl1",
    ])
  })

  it("adds nothing that the file already has, and reports a link without a GitHub connection", () => {
    const { changes, report } = planSourceMigration({
      workspaces: [
        workspace(
          "context",
          "version: 1\nsources:\n  - {id: issues, provider: linear, connection: con_lin1, teams: [ENG]}\n",
        ),
        workspace("orphan", null, null),
      ],
      linked: [
        { workspaceId: "orphan", gitUrl: "https://github.com/acme/api" },
      ],
      bindings: [
        {
          provider: "linear",
          connectionId: "con_lin1",
          syncRepositoryUrl: "https://github.com/acme/context.git",
          scope: {},
        },
      ],
    })
    expect(changes.size).toBe(0)
    expect(report.alreadyPresent).toEqual([
      { workspaceId: "context", provider: "linear", connectionId: "con_lin1" },
    ])
    expect(report.unmapped).toMatchObject([
      { provider: "github", workspaceId: "orphan" },
    ])
  })
})

describe("planSourceMigration: repository files", () => {
  it("deletes the repository files of the GitHub repositories that move, and keeps a file that pins a branch or names another host", () => {
    const { changes, deletePaths } = planSourceMigration({
      workspaces: [
        {
          ...workspace("eng"),
          repositoryFiles: [
            {
              path: "repositories/api.md",
              content: "---\ngit: https://github.com/Acme/API.git\n---\n",
            },
            {
              path: "repositories/web.md",
              content:
                "---\ngit: https://github.com/acme/web\nbranch: release\n---\n",
            },
            {
              path: "repositories/tools.md",
              content: "---\ngit: https://gitlab.example/acme/tools\n---\n",
            },
          ],
        },
      ],
      linked: [
        { workspaceId: "eng", gitUrl: "https://github.com/acme/api" },
        { workspaceId: "eng", gitUrl: "https://github.com/acme/web" },
        { workspaceId: "eng", gitUrl: "https://gitlab.example/acme/tools" },
      ],
      bindings: [],
    })
    // A branch pin has no place in the GitHub scope, so web stays a file.
    expect(changes.get("eng")).toMatchObject([
      { provider: "github", scope: { repositories: ["acme/api"] } },
    ])
    expect(deletePaths.get("eng")).toEqual(["repositories/api.md"])
  })
})
