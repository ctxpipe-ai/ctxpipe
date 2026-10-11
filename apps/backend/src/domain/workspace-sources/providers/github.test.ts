import { describe, expect, it } from "vitest"
import { planSourceMigration } from "../migration-plan.js"
import { parseSourceEntry } from "../sources-file.js"
import { githubSourceScope } from "./github.js"

describe("githubSourceScope", () => {
  it("accepts linked repositories as owner/name", () => {
    const parsed = parseSourceEntry({
      id: "product-repos",
      provider: "github",
      connection: "con_github1",
      repositories: ["acme/web", "acme/api"],
    })
    expect(parsed).toMatchObject({
      ok: true,
      entry: { scope: { repositories: ["acme/web", "acme/api"] } },
    })
  })

  it("refuses an empty list, a URL, a repeated repository, and an extra key", () => {
    for (const scope of [
      { repositories: [] },
      { repositories: ["https://github.com/acme/web"] },
      { repositories: ["acme/web", "ACME/web"] },
      { repositories: ["acme/web"], branch: "main" },
    ])
      expect(githubSourceScope.schema.safeParse(scope).success).toBe(false)
  })

  it("summarizes the number of linked repositories", () => {
    expect(githubSourceScope.summarize({ repositories: ["acme/web"] })).toBe(
      "1 linked repository",
    )
    expect(
      githubSourceScope.summarize({
        repositories: ["acme/web", "acme/api", "acme/docs"],
      }),
    ).toBe("3 linked repositories")
  })
})

describe("the GitHub migration of linked repositories", () => {
  it("gives an entry that the GitHub scope accepts", () => {
    const { changes } = planSourceMigration({
      workspaces: [
        {
          id: "ws_eng",
          workspaceRepositoryUrl: "https://github.com/acme/knowledge.git",
          githubConnectionId: "con_github1",
          sourcesFile: null,
        },
      ],
      linked: [
        { workspaceId: "ws_eng", gitUrl: "https://github.com/Acme/Web.git" },
        { workspaceId: "ws_eng", gitUrl: "git@github.com:acme/api.git" },
        { workspaceId: "ws_eng", gitUrl: "https://gitlab.example/acme/x" },
      ],
      bindings: [],
    })
    const [change] = changes.get("ws_eng") ?? []
    expect(change).toMatchObject({ provider: "github" })
    expect(
      parseSourceEntry({
        id: "linked-repositories",
        provider: "github",
        connection: "con_github1",
        ...(change && "scope" in change ? change.scope : {}),
      }),
    ).toMatchObject({
      ok: true,
      entry: { scope: { repositories: ["acme/api", "acme/web"] } },
    })
  })
})
