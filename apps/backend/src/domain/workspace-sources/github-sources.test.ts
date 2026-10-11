import { describe, expect, it } from "vitest"
import {
  githubNoAccessDetail,
  githubSourceRepositories,
  repositoriesWithoutAccess,
} from "./github-sources.js"

describe("githubSourceRepositories", () => {
  it("lists the repositories of each valid GitHub entry with its connection", () => {
    const text = [
      "version: 1",
      "sources:",
      "  - id: product-repos",
      "    provider: github",
      "    connection: con_github1",
      "    repositories: [acme/web, acme/api]",
      "  - id: broken",
      "    provider: github",
      "    connection: con_github1",
      "    repositories: []",
      "  - id: eng-issues",
      "    provider: linear",
      "    connection: con_linear1",
      "    teams: [ENG]",
    ].join("\n")
    expect(githubSourceRepositories(text)).toEqual([
      {
        gitUrl: "https://github.com/acme/web",
        connectionId: "con_github1",
      },
      {
        gitUrl: "https://github.com/acme/api",
        connectionId: "con_github1",
      },
    ])
  })

  it("gives nothing for an absent, invalid, or unreadable file", () => {
    expect(githubSourceRepositories(null)).toEqual([])
    expect(githubSourceRepositories("version: 2\nsources: []")).toEqual([])
    expect(githubSourceRepositories("sources: [")).toEqual([])
  })
})

describe("the no-access detail", () => {
  it("names the repositories, and the same repositories come back from it", () => {
    const detail = githubNoAccessDetail(["acme/hidden", "acme/private"])
    expect(detail).toContain("acme/hidden, acme/private")
    expect(repositoriesWithoutAccess(detail)).toEqual([
      "https://github.com/acme/hidden",
      "https://github.com/acme/private",
    ])
  })

  it("gives no repository for another detail", () => {
    expect(repositoriesWithoutAccess(null)).toEqual([])
    expect(
      repositoriesWithoutAccess("The connection does not exist in this org"),
    ).toEqual([])
  })
})
