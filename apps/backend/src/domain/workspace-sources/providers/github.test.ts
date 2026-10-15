import { describe, expect, it } from "vitest"
import { planSourceMigration } from "../migration-plan.js"
import { parseSourceEntry } from "../sources-file.js"
import {
  githubScopeRepositories,
  githubScopeSchema,
  githubSourceScope,
} from "./github.js"

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

  it("accepts a repository with a branch or tag ref", () => {
    const scope = {
      repositories: ["acme/web", { name: "acme/api", ref: "release/2.x" }],
    }
    expect(githubSourceScope.schema.safeParse(scope).success).toBe(true)
    expect(githubScopeRepositories(githubScopeSchema.parse(scope))).toEqual([
      { name: "acme/web", ref: null },
      { name: "acme/api", ref: "release/2.x" },
    ])
  })

  it("refuses a bad ref, an extra item key, and a name repeated in a map", () => {
    for (const scope of [
      { repositories: [{ name: "acme/web", ref: "bad ref" }] },
      { repositories: [{ name: "acme/web", ref: "a..b" }] },
      { repositories: [{ name: "acme/web", branch: "main" }] },
      { repositories: ["acme/web", { name: "ACME/web", ref: "dev" }] },
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
  it("gives an entry that the GitHub scope accepts, with a branch as ref", () => {
    const { changes } = planSourceMigration({
      workspaces: [
        {
          id: "ws_eng",
          workspaceRepositoryUrl: "https://github.com/acme/knowledge.git",
          githubConnectionId: "con_github1",
          sourcesFile: null,
          repositoryFiles: [
            "https://github.com/Acme/Web.git",
            "git@github.com:acme/api.git",
            "https://gitlab.example/acme/x",
          ].map((git, index) => ({
            path: `repositories/r${index}.md`,
            content: `---\ngit: ${git}\n${index === 0 ? "branch: release\n" : ""}---\n`,
          })),
        },
      ],
      linked: [],
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
      entry: {
        scope: {
          repositories: ["acme/api", { name: "acme/web", ref: "release" }],
        },
      },
    })
  })
})
