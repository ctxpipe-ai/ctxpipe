import { describe, expect, it } from "vitest"
import { parseSourceFile } from "../workspace-sources/source-file-text.js"
import { changeLinkedRepository } from "./link-declarations.js"

const declaration = (git: string, branch?: string) =>
  `---\ngit: ${git}\n${branch ? `branch: ${branch}\n` : ""}---\n`

const githubFile = (repository: string, body = "") =>
  `---\nprovider: github\nconnection: con_gh\nrepository: ${repository}\n---\n${body}`

describe("changeLinkedRepository", () => {
  it("link writes one source file for the repository", () => {
    const result = changeLinkedRepository({
      action: "link",
      gitUrl: "https://github.com/Acme/Web",
      connectionId: "con_gh",
      files: [],
    })
    expect(result.refused).toBeNull()
    expect(result.deletePaths).toEqual([])
    expect(result.files.map((file) => file.path)).toEqual([
      "sources/github/acme/web.md",
    ])
    expect(
      parseSourceFile(
        "sources/github/acme/web.md",
        result.files[0]?.content ?? "",
      ),
    ).toMatchObject({
      ok: true,
      source: { connectionId: "con_gh", scope: { repository: "acme/web" } },
    })
  })

  it("link twice gives one file", () => {
    const first = changeLinkedRepository({
      action: "link",
      gitUrl: "https://github.com/acme/web",
      connectionId: "con_gh",
      files: [],
    })
    const second = changeLinkedRepository({
      action: "link",
      gitUrl: "https://github.com/acme/web.git",
      connectionId: "con_gh",
      files: first.files,
    })
    expect(second).toEqual({ files: [], deletePaths: [], refused: null })
  })

  it("link writes only its own file and keeps another repository file byte for byte", () => {
    const web = `${declaration("https://github.com/acme/web", "dev")}Web docs.\n`
    const result = changeLinkedRepository({
      action: "link",
      gitUrl: "https://github.com/acme/api",
      connectionId: "con_gh",
      files: [{ path: "repositories/web.md", content: web }],
    })
    expect(result.refused).toBeNull()
    expect(result.deletePaths).toEqual([])
    expect(result.files.map((file) => file.path)).toEqual([
      "sources/github/acme/api.md",
    ])
  })

  it("link changes nothing when a repository file already declares the repository", () => {
    expect(
      changeLinkedRepository({
        action: "link",
        gitUrl: "https://github.com/acme/web",
        connectionId: "con_gh",
        files: [
          {
            path: "repositories/web.md",
            content: `${declaration("https://github.com/acme/web", "dev")}Body.\n`,
          },
        ],
      }),
    ).toEqual({ files: [], deletePaths: [], refused: null })
  })

  it("link changes nothing when the legacy file already links the repository", () => {
    expect(
      changeLinkedRepository({
        action: "link",
        gitUrl: "https://github.com/acme/web",
        connectionId: "con_gh",
        files: [
          {
            path: ".ctxpipe/sources.yaml",
            content:
              "version: 1\nsources:\n  - id: repos\n    provider: github\n    connection: con_gh\n    repositories: [acme/web]\n",
          },
        ],
      }),
    ).toEqual({ files: [], deletePaths: [], refused: null })
  })

  it("unlink deletes the file of the repository and keeps the others", () => {
    const result = changeLinkedRepository({
      action: "unlink",
      gitUrl: "https://github.com/acme/web",
      connectionId: "con_gh",
      files: [
        {
          path: "sources/github/acme/web.md",
          content: githubFile("acme/web", "Keep me out of the diff.\n"),
        },
        {
          path: "sources/github/acme/api.md",
          content: githubFile("acme/api"),
        },
      ],
    })
    expect(result).toEqual({
      files: [],
      deletePaths: ["sources/github/acme/web.md"],
      refused: null,
    })
  })

  it("unlink also removes the repository from the legacy file and its declaration", () => {
    const result = changeLinkedRepository({
      action: "unlink",
      gitUrl: "https://github.com/acme/web",
      connectionId: "con_gh",
      files: [
        {
          path: ".ctxpipe/sources.yaml",
          content:
            "version: 1\nsources:\n  - id: repos\n    provider: github\n    connection: con_gh\n    repositories: [acme/web, acme/api]\n",
        },
        {
          path: "repositories/web.md",
          content: declaration("https://github.com/acme/web"),
        },
      ],
    })
    expect(result.deletePaths).toEqual(["repositories/web.md"])
    expect(result.files[0]?.path).toBe(".ctxpipe/sources.yaml")
    expect(result.files[0]?.content).toContain("acme/api")
    expect(result.files[0]?.content).not.toContain("acme/web")
  })

  it("refuses an unlink when the file of the repository cannot be read", () => {
    const result = changeLinkedRepository({
      action: "unlink",
      gitUrl: "https://github.com/acme/web",
      connectionId: "con_gh",
      files: [
        {
          path: "sources/github/acme/web.md",
          content: "---\nprovider: github\nconnection: [\n---\n",
        },
      ],
    })
    expect(result.files).toEqual([])
    expect(result.deletePaths).toEqual([])
    expect(result.refused).toMatch(/sources\/github\/acme\/web\.md/)
  })

  it("refuses a repository outside GitHub and changes nothing", () => {
    expect(
      changeLinkedRepository({
        action: "link",
        gitUrl: "https://gitlab.com/acme/tools",
        connectionId: "con_gh",
        files: [],
      }),
    ).toEqual({
      files: [],
      deletePaths: [],
      refused: "Only a GitHub repository can be linked to a Workspace",
    })
  })

  it("refuses a link when a file of another repository has the path", () => {
    const result = changeLinkedRepository({
      action: "link",
      gitUrl: "https://github.com/acme/web",
      connectionId: "con_gh",
      files: [
        {
          path: "sources/github/acme/web.md",
          content: "not a source file",
        },
      ],
    })
    expect(result.refused).toContain("sources/github/acme/web.md")
    expect(result.files).toEqual([])
  })
})
