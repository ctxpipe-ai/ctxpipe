import { describe, expect, it } from "vitest"
import { SourceChangeError } from "./edit.js"
import {
  linkGithubRepositories,
  unlinkGithubRepository,
} from "./github-links.js"
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
