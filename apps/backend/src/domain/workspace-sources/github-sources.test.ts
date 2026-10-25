import { describe, expect, it } from "vitest"

import {
  githubSourcePathOf,
  githubSourceRepositories,
} from "./github-sources.js"

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
        path: ".ctxpipe/sources.yaml",
      },
      {
        gitUrl: "https://github.com/acme/api",
        ref: "v2",
        connectionId: "con_github1",
        path: ".ctxpipe/sources.yaml",
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

  it("lists the repository of each valid GitHub source file before the YAML entries, with the path that declares it", () => {
    const files = [
      {
        path: "sources/github/acme/web.md",
        text: "---\nprovider: github\nconnection: con_github1\nrepository: acme/web\nref: main\n---\n",
      },
      {
        path: "sources/github/acme/broken.md",
        text: "---\nprovider: github\nconnection: con_github1\n---\n",
      },
      {
        path: "sources/github/acme/secret.md",
        text: "---\nprovider: github\nconnection: con_elsewhere\nrepository: acme/secret\n---\n",
      },
      {
        path: "sources/linear/eng.md",
        text: "---\nprovider: linear\nconnection: con_github1\nteams: [ENG]\n---\n",
      },
    ]
    expect(
      githubSourceRepositories(
        "version: 1\nsources:\n  - {id: code, provider: github, connection: con_github1, repositories: [acme/api]}\n",
        connections,
        files,
      ),
    ).toEqual([
      {
        gitUrl: "https://github.com/acme/web",
        ref: "main",
        connectionId: "con_github1",
        path: "sources/github/acme/web.md",
      },
      {
        gitUrl: "https://github.com/acme/api",
        ref: null,
        connectionId: "con_github1",
        path: ".ctxpipe/sources.yaml",
      },
    ])
  })

  it("links the new repository of a later YAML entry that also names a linked one", () => {
    const text = [
      "version: 1",
      "sources:",
      "  - {id: web, provider: github, connection: con_github1, repositories: [acme/web]}",
      "  - {id: apps, provider: github, connection: con_github1, repositories: [{name: acme/web, ref: next}, acme/api]}",
    ].join("\n")
    expect(githubSourceRepositories(text, connections)).toEqual([
      {
        gitUrl: "https://github.com/acme/web",
        ref: null,
        connectionId: "con_github1",
        path: ".ctxpipe/sources.yaml",
      },
      {
        gitUrl: "https://github.com/acme/api",
        ref: null,
        connectionId: "con_github1",
        path: ".ctxpipe/sources.yaml",
      },
    ])
  })

  it("links a repository from the source file that holds it, not from a YAML entry", () => {
    const text =
      "version: 1\nsources:\n  - {id: apps, provider: github, connection: con_github1, repositories: [{name: acme/web, ref: next}, acme/api]}\n"
    const file = {
      path: "sources/github/acme/web.md",
      text: "---\nprovider: github\nconnection: con_github1\nrepository: acme/web\nref: main\n---\n",
    }
    expect(
      githubSourceRepositories(text, connections, [file], {
        previousRows: [
          {
            sourceKey: file.path,
            provider: "github",
            connectionId: "con_github1",
            scope: { repository: "acme/web", ref: "main" },
            status: "ok",
          },
        ],
      }),
    ).toEqual([
      {
        gitUrl: "https://github.com/acme/web",
        ref: "main",
        connectionId: "con_github1",
        path: "sources/github/acme/web.md",
      },
      {
        gitUrl: "https://github.com/acme/api",
        ref: null,
        connectionId: "con_github1",
        path: ".ctxpipe/sources.yaml",
      },
    ])
  })
})

describe("githubSourcePathOf", () => {
  const pin = (gitUrl: string) => ({
    provider: "github",
    repositories: [
      {
        id: "wlr_1",
        gitUrl,
        ref: null,
        desiredSha: null,
        indexedSha: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  })

  it("finds the source file that pins the repository, whatever its path", () => {
    const rows = [
      {
        id: "a",
        provider: "github",
        sourceKey: "sources/github/acme/web.md",
        state: pin("https://github.com/acme/web"),
      },
      {
        id: "b",
        provider: "github",
        sourceKey: "sources/github/team/api-renamed.md",
        state: pin("https://github.com/acme/api"),
      },
    ]
    expect(githubSourcePathOf(rows, "https://github.com/Acme/API.git")).toBe(
      "sources/github/team/api-renamed.md",
    )
    expect(githubSourcePathOf(rows, "https://github.com/acme/none")).toBeNull()
  })

  it("ignores a row whose key is not a source path", () => {
    expect(
      githubSourcePathOf(
        [
          {
            id: "a",
            provider: "github",
            sourceKey: "legacy-key",
            state: pin("https://github.com/acme/web"),
          },
        ],
        "https://github.com/acme/web",
      ),
    ).toBeNull()
  })
})
