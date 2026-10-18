import { describe, expect, it } from "vitest"
import { SourceChangeError } from "./edit.js"
import {
  linkGithubRepositories,
  linkGithubSourceFile,
  unlinkGithubRepository,
  unlinkGithubSourceFile,
} from "./github-links.js"
import { parseSourceEntry } from "./sources-file.js"
import { parseSourcesYaml } from "./sources-yaml.js"

const file = (sources: unknown[]) =>
  `version: 1\nsources:\n${sources.map((entry) => `  - ${JSON.stringify(entry)}`).join("\n")}\n`

describe("linkGithubRepositories", () => {
  it("makes the linked-repositories entry, with a ref only where one is set", () => {
    const text = linkGithubRepositories({
      sourcesFile: null,
      connectionId: "con_gh1",
      repositories: [
        { name: "acme/web", ref: null },
        { name: "acme/api", ref: "release" },
      ],
    })
    expect(parseSourcesYaml(text ?? "")).toEqual({
      version: 1,
      sources: [
        {
          id: "linked-repositories",
          provider: "github",
          connection: "con_gh1",
          repositories: ["acme/web", { name: "acme/api", ref: "release" }],
        },
      ],
    })
  })

  it("adds to the GitHub entry of the same connection and keeps other entries", () => {
    const text = linkGithubRepositories({
      sourcesFile: file([
        { id: "lin", provider: "linear", connection: "con_lin", teams: ["A"] },
        {
          id: "repos",
          provider: "github",
          connection: "con_gh1",
          repositories: [{ name: "acme/web", ref: "main" }],
        },
      ]),
      connectionId: "con_gh1",
      repositories: [{ name: "acme/api", ref: null }],
    })
    const parsed = parseSourcesYaml(text ?? "") as {
      sources: Array<Record<string, unknown>>
    }
    expect(parsed.sources).toHaveLength(2)
    expect(parsed.sources[1]).toMatchObject({
      id: "repos",
      repositories: [{ name: "acme/web", ref: "main" }, "acme/api"],
    })
  })

  it("changes nothing when a GitHub entry already links the repository", () => {
    expect(
      linkGithubRepositories({
        sourcesFile: file([
          {
            id: "other",
            provider: "github",
            connection: "con_gh2",
            repositories: [{ name: "Acme/Web", ref: "main" }, "acme/api"],
          },
        ]),
        connectionId: "con_gh1",
        repositories: [
          { name: "acme/web", ref: "dev" },
          { name: "acme/api", ref: null },
        ],
      }),
    ).toBeNull()
  })

  it("gives the ref to a link that has no ref, in its own entry", () => {
    const text = linkGithubRepositories({
      sourcesFile: file([
        {
          id: "other",
          provider: "github",
          connection: "con_gh2",
          repositories: ["Acme/Web", "acme/api"],
        },
      ]),
      connectionId: "con_gh1",
      repositories: [{ name: "acme/web", ref: "dev" }],
    })
    expect(parseSourcesYaml(text ?? "")).toEqual({
      version: 1,
      sources: [
        {
          id: "other",
          provider: "github",
          connection: "con_gh2",
          repositories: [{ name: "Acme/Web", ref: "dev" }, "acme/api"],
        },
      ],
    })
  })

  it("links the 101st repository in a new linked-repositories-2 entry when the entry is full", () => {
    const names = Array.from({ length: 101 }, (_, i) => `acme/repo-${i}`)
    const full = linkGithubRepositories({
      sourcesFile: null,
      connectionId: "con_gh1",
      repositories: names
        .slice(0, 100)
        .map((name) => ({ name, ref: null as string | null })),
    })
    const text = linkGithubRepositories({
      sourcesFile: full,
      connectionId: "con_gh1",
      repositories: [{ name: names[100] ?? "", ref: null }],
    })
    const parsed = parseSourcesYaml(text ?? "") as {
      sources: Array<{ id: string; repositories: string[] }>
    }
    expect(parsed.sources.map((entry) => entry.id)).toEqual([
      "linked-repositories",
      "linked-repositories-2",
    ])
    expect(parsed.sources[0]?.repositories).toHaveLength(100)
    expect(parsed.sources[1]?.repositories).toEqual([names[100]])
    expect(parsed.sources.every((raw) => parseSourceEntry(raw).ok)).toBe(true)
  })

  it("splits more repositories than the cap into entries of at most the cap", () => {
    const text = linkGithubRepositories({
      sourcesFile: null,
      connectionId: "con_gh1",
      repositories: Array.from({ length: 201 }, (_, i) => ({
        name: `acme/repo-${i}`,
        ref: null,
      })),
    })
    const parsed = parseSourcesYaml(text ?? "") as {
      sources: Array<{ id: string; repositories: string[] }>
    }
    expect(
      parsed.sources.map((entry) => [entry.id, entry.repositories.length]),
    ).toEqual([
      ["linked-repositories", 100],
      ["linked-repositories-2", 100],
      ["linked-repositories-3", 1],
    ])
  })

  it("counts the repositories of a stored entry above the cap as linked", () => {
    const stored = Array.from({ length: 101 }, (_, i) => `acme/repo-${i}`)
    const sourcesFile = file([
      {
        id: "linked-repositories",
        provider: "github",
        connection: "con_gh1",
        repositories: stored,
      },
    ])
    expect(
      linkGithubRepositories({
        sourcesFile,
        connectionId: "con_gh1",
        repositories: [{ name: "acme/repo-100", ref: null }],
      }),
    ).toBeNull()
    expect(
      unlinkGithubRepository({ sourcesFile, name: "acme/repo-0" }),
    ).not.toBeNull()
  })

  it("refuses a file that is not version 1", () => {
    expect(() =>
      linkGithubRepositories({
        sourcesFile: "version: 2\n",
        connectionId: "con_gh1",
        repositories: [{ name: "acme/web", ref: null }],
      }),
    ).toThrow(SourceChangeError)
  })
})

describe("unlinkGithubRepository", () => {
  it("removes the repository and an entry with no repository left", () => {
    const text = unlinkGithubRepository({
      sourcesFile: file([
        {
          id: "a",
          provider: "github",
          connection: "con_gh1",
          repositories: [{ name: "acme/web", ref: "dev" }, "acme/api"],
        },
        {
          id: "b",
          provider: "github",
          connection: "con_gh2",
          repositories: ["ACME/web"],
        },
      ]),
      name: "acme/web",
    })
    expect(parseSourcesYaml(text ?? "")).toEqual({
      version: 1,
      sources: [
        {
          id: "a",
          provider: "github",
          connection: "con_gh1",
          repositories: ["acme/api"],
        },
      ],
    })
  })

  it("returns null when no entry links the repository", () => {
    expect(
      unlinkGithubRepository({
        sourcesFile: file([
          {
            id: "a",
            provider: "github",
            connection: "con_gh1",
            repositories: ["acme/api"],
          },
        ]),
        name: "acme/web",
      }),
    ).toBeNull()
    expect(
      unlinkGithubRepository({ sourcesFile: null, name: "acme/web" }),
    ).toBeNull()
  })
})

describe("linkGithubSourceFile", () => {
  const file = (extra = "") =>
    `---\nprovider: github\nconnection: con_gh1\nrepository: acme/web\n${extra}---\nWhy we read it.\n`

  it("gives the ref to a linked repository that has none and keeps the body", () => {
    const result = linkGithubSourceFile({
      files: [{ path: "sources/github/acme/web.md", content: file() }],
      connectionId: "con_gh1",
      repository: { name: "acme/web", ref: "release" },
    })
    expect(result?.deletes).toEqual([])
    expect(result?.writes[0]).toMatchObject({
      path: "sources/github/acme/web.md",
    })
    expect(result?.writes[0]?.content).toContain("ref: release")
    expect(result?.writes[0]?.content.endsWith("---\nWhy we read it.\n")).toBe(
      true,
    )
  })

  it("changes nothing when the repository has a ref or the request has none", () => {
    const files = [
      { path: "sources/github/acme/web.md", content: file("ref: main\n") },
    ]
    expect(
      linkGithubSourceFile({
        files,
        connectionId: "con_gh1",
        repository: { name: "acme/web", ref: "release" },
      }),
    ).toBeNull()
    expect(
      linkGithubSourceFile({
        files: [{ path: "sources/github/acme/web.md", content: file() }],
        connectionId: "con_gh1",
        repository: { name: "Acme/Web", ref: null },
      }),
    ).toBeNull()
  })
})

describe("unlinkGithubSourceFile", () => {
  it("deletes each file of the repository, matched without case, and nothing else", () => {
    const content = (repository: string) =>
      `---\nprovider: github\nconnection: con_gh1\nrepository: ${repository}\n---\n`
    expect(
      unlinkGithubSourceFile({
        files: [
          { path: "sources/github/acme/web.md", content: content("Acme/Web") },
          { path: "sources/github/acme/api.md", content: content("acme/api") },
        ],
        name: "acme/web",
      }),
    ).toEqual({ writes: [], deletes: ["sources/github/acme/web.md"] })
    expect(unlinkGithubSourceFile({ files: [], name: "acme/web" })).toBeNull()
  })
})
