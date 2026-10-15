import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { changeLinkedRepository } from "./link-declarations.js"

const declaration = (git: string, branch?: string) =>
  `---\ngit: ${git}\n${branch ? `branch: ${branch}\n` : ""}---\n`

describe("changeLinkedRepository", () => {
  it("moves the GitHub repository files into sources.yaml before the edit", () => {
    const result = changeLinkedRepository({
      sourcesFile: null,
      action: "link",
      gitUrl: "https://github.com/acme/web",
      connectionId: "con_gh",
      files: [
        {
          path: "repositories/web.md",
          content: declaration("https://github.com/acme/web", "stable"),
        },
        {
          path: "repositories/tools.md",
          content: declaration("https://gitlab.com/acme/tools"),
        },
      ],
    })
    expect(result.refused).toBeNull()
    expect(result.deletePaths).toEqual(["repositories/web.md"])
    expect(result.files).toHaveLength(1)
    // The file keeps its branch; the link of the same repository adds nothing.
    expect(parse(result.files[0]?.content ?? "").sources).toEqual([
      {
        id: "linked-repositories",
        provider: "github",
        connection: "con_gh",
        repositories: [{ name: "acme/web", ref: "stable" }],
      },
    ])
  })

  it("unlinks a repository that only a repository file declared", () => {
    const result = changeLinkedRepository({
      sourcesFile: null,
      action: "unlink",
      gitUrl: "https://github.com/acme/web",
      connectionId: "con_gh",
      files: [
        {
          path: "repositories/web.md",
          content: declaration("https://github.com/acme/web"),
        },
        {
          path: "repositories/api.md",
          content: declaration("https://github.com/acme/api"),
        },
      ],
    })
    expect(result.deletePaths).toEqual([
      "repositories/web.md",
      "repositories/api.md",
    ])
    expect(parse(result.files[0]?.content ?? "").sources).toEqual([
      {
        id: "linked-repositories",
        provider: "github",
        connection: "con_gh",
        repositories: ["acme/api"],
      },
    ])
  })

  it("refuses a repository outside GitHub and changes nothing", () => {
    expect(
      changeLinkedRepository({
        sourcesFile: null,
        action: "link",
        gitUrl: "https://gitlab.com/acme/tools",
        connectionId: "con_gh",
        files: [
          {
            path: "repositories/web.md",
            content: declaration("https://github.com/acme/web"),
          },
        ],
      }),
    ).toEqual({
      files: [],
      deletePaths: [],
      refused: "Only a GitHub repository can be linked to a Workspace",
    })
  })
})
