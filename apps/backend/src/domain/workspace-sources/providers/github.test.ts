import { describe, expect, it } from "vitest"
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
