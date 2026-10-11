import { describe, expect, it } from "vitest"
import { githubSourceRepositories } from "./github-sources.js"

const connections = new Set(["con_github1"])

describe("githubSourceRepositories", () => {
  it("lists the repositories of each valid GitHub entry whose connection is a GitHub connection of the org", () => {
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
      "  - id: other-org",
      "    provider: github",
      "    connection: con_elsewhere",
      "    repositories: [acme/secret]",
    ].join("\n")
    expect(githubSourceRepositories(text, connections)).toEqual([
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
    expect(githubSourceRepositories(null, connections)).toEqual([])
    expect(
      githubSourceRepositories("version: 2\nsources: []", connections),
    ).toEqual([])
    expect(githubSourceRepositories("sources: [", connections)).toEqual([])
  })
})
