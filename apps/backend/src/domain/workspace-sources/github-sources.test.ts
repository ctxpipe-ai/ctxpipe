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
      "    repositories: [acme/web, {name: acme/api, ref: v2}]",
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
        ref: null,
        connectionId: "con_github1",
      },
      {
        gitUrl: "https://github.com/acme/api",
        ref: "v2",
        connectionId: "con_github1",
      },
    ])
    // Without a connection set, each valid GitHub entry links.
    expect(
      githubSourceRepositories(text, null).map((item) => item.gitUrl),
    ).toEqual([
      "https://github.com/acme/web",
      "https://github.com/acme/api",
      "https://github.com/acme/secret",
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
