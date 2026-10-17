import { describe, expect, it } from "vitest"
import {
  FILE_ERROR_SOURCE_KEY,
  planSourceRows,
  unmatchedSourceDetail,
} from "./projection-plan.js"
import type { SourceProvider, SourceStatus } from "./sources-file.js"

const connections = new Map([
  ["con_linear1", { id: "con_linear1", type: "linear" }],
  ["con_forge1", { id: "con_forge1", type: "forge" }],
])

describe("planSourceRows", () => {
  it("gives no rows when the file is absent or empty", async () => {
    expect(await planSourceRows({ text: null, connections })).toEqual([])
    expect(await planSourceRows({ text: "", connections })).toEqual([])
  })

  it("records a file-level error in one reserved row", async () => {
    const [bad] = await planSourceRows({ text: "version: 2\n", connections })
    expect(bad).toMatchObject({
      sourceKey: FILE_ERROR_SOURCE_KEY,
      status: "invalid",
    })
    const [yaml] = await planSourceRows({ text: "a: [\n", connections })
    expect(yaml?.statusDetail).toContain("not valid YAML")
  })

  it("gives each entry a status", async () => {
    const rows = await planSourceRows({
      text: `version: 1
sources:
  - id: eng-issues
    provider: linear
    connection: con_linear1
    teams: [ENG]
  - id: eng-docs
    provider: confluence
    connection: con_linear1
    spaces: [{ key: ENG, pages: all }]
  - id: gone
    provider: notion
    connection: con_missing1
    pages: [{ id: 1a2b3c4d-0000-4000-8000-000000000001, title: Gone }]
  - id: no-provider
    connection: con_linear1
  - provider: slack
  - id: eng-issues
    provider: linear
    connection: con_linear1
`,
      connections,
      checkAccess: async (entry) =>
        entry.scope.teams ? null : "The connection cannot read this scope",
    })
    expect(
      rows.map((row) => [row.sourceKey, row.status, row.statusDetail]),
    ).toEqual([
      [
        "eng-issues",
        "invalid",
        'The id "eng-issues" is used by more than one entry',
      ],
      [
        "eng-docs",
        "invalid",
        "The connection is a linear connection, not forge",
      ],
      [
        "gone",
        "connection_missing",
        "The connection does not exist in this organization",
      ],
      ["no-provider", "invalid", expect.stringContaining("provider")],
      [".entry-5", "invalid", expect.any(String)],
    ])
    expect(rows[0]?.scope).toEqual({ teams: ["ENG"] })
  })

  it("marks an entry out of the connection's reach as out_of_access", async () => {
    const [row] = await planSourceRows({
      text: "version: 1\nsources:\n  - {id: docs, provider: confluence, connection: con_forge1, spaces: [{key: ENG, pages: all}]}\n",
      connections,
      checkAccess: async () => "Space ENG is not in this site",
    })
    expect(row).toMatchObject({
      status: "out_of_access",
      statusDetail: "Space ENG is not in this site",
    })
  })

  it("records a file error for an oversized file or too many aliases", async () => {
    const [big] = await planSourceRows({
      text: `version: 1\nsources: []\n# ${"x".repeat(300_000)}\n`,
      connections,
    })
    expect(big?.statusDetail).toContain("larger than")
    const [bomb] = await planSourceRows({
      text: `version: 1\nsources: []\nbomb: &a [x]\nmore: [${Array.from({ length: 200 }, () => "*a").join(", ")}]\n`,
      connections,
    })
    expect(bomb).toMatchObject({ sourceKey: ".file", status: "invalid" })
  })

  it("shows each repository file that cannot move as an invalid row", async () => {
    const rows = await planSourceRows({
      text: null,
      connections,
      leftoverFiles: [
        {
          path: "repositories/tools.md",
          reason: "ctx| links only GitHub repositories",
        },
      ],
    })
    expect(rows).toEqual([
      {
        sourceKey: "repositories/tools.md",
        provider: null,
        connectionId: null,
        scope: {},
        status: "invalid",
        statusDetail:
          "repositories/tools.md: ctx| links only GitHub repositories. Move the link into a file under sources/github/ or remove the file.",
      },
    ])
  })
})

const fileConnections = new Map([
  ["con_github1", { id: "con_github1", type: "github" }],
  ["con_linear1", { id: "con_linear1", type: "linear" }],
])

function githubFile(path: string, repository: string, ref?: string) {
  return {
    path,
    text: `---\nprovider: github\nconnection: con_github1\nrepository: ${repository}\n${ref ? `ref: ${ref}\n` : ""}---\n\nNotes.\n`,
  }
}

function linearFile(path: string, team: string) {
  return {
    path,
    text: `---\nprovider: linear\nconnection: con_linear1\nteams: [${team}]\n---\n`,
  }
}

/** The managed path of a fake Linear scope: one folder for each team. */
const linearManagedPaths = (entry: { scope: Record<string, unknown> }) =>
  ((entry.scope.teams as string[] | undefined) ?? []).map(
    (team) => `linear/teams/${team}/`,
  )

function previousRow(
  sourceKey: string,
  status: SourceStatus,
  scope: Record<string, unknown>,
  provider: SourceProvider = "github",
) {
  return {
    sourceKey,
    provider,
    connectionId: provider === "github" ? "con_github1" : "con_linear1",
    scope,
    status,
  }
}

function statuses(rows: Awaited<ReturnType<typeof planSourceRows>>) {
  return rows.map((row) => [row.sourceKey, row.status, row.statusDetail])
}

describe("planSourceRows from source files", () => {
  it("gives one row for each file, keyed by its path", async () => {
    const rows = await planSourceRows({
      text: null,
      files: [
        githubFile("sources/github/acme/web.md", "acme/web", "main"),
        linearFile("sources/linear/eng.md", "ENG"),
      ],
      connections: fileConnections,
    })
    expect(rows).toEqual([
      {
        sourceKey: "sources/github/acme/web.md",
        provider: "github",
        connectionId: "con_github1",
        scope: { repository: "acme/web", ref: "main" },
        status: "ok",
        statusDetail: null,
      },
      {
        sourceKey: "sources/linear/eng.md",
        provider: "linear",
        connectionId: "con_linear1",
        scope: { teams: ["ENG"] },
        status: "ok",
        statusDetail: null,
      },
    ])
  })

  it("gives an invalid row for a malformed file and for a file that breaks the path rules", async () => {
    const rows = await planSourceRows({
      text: null,
      files: [
        { path: "sources/linear/broken.md", text: "---\nprovider: [\n---\n" },
        { path: "sources/linear/eng.yaml", text: "provider: linear\n" },
        linearFile("sources/slack/eng.md", "ENG"),
      ],
      connections: fileConnections,
    })
    expect(statuses(rows)).toEqual([
      ["sources/linear/broken.md", "invalid", expect.stringContaining("YAML")],
      ["sources/linear/eng.yaml", "invalid", expect.stringContaining(".md")],
      ["sources/slack/eng.md", "invalid", expect.stringContaining("folder")],
    ])
    expect(rows[0]?.provider).toBe("linear")
  })

  it("gives an invalid row for a blob that the tree read omitted", async () => {
    const rows = await planSourceRows({
      text: null,
      files: [
        { path: "sources/linear/big.md", text: "", omitted: "too_large" },
        { path: "sources/linear/logo.md", text: "", omitted: "binary" },
      ],
      connections: fileConnections,
    })
    expect(statuses(rows)).toEqual([
      ["sources/linear/big.md", "invalid", "The file is larger than 64 KiB"],
      ["sources/linear/logo.md", "invalid", "The file is not text"],
    ])
  })

  it("checks the connection of a file as it checks a YAML entry", async () => {
    const rows = await planSourceRows({
      text: null,
      files: [
        {
          path: "sources/linear/gone.md",
          text: "---\nprovider: linear\nconnection: con_gone\nteams: [ENG]\n---\n",
        },
        {
          path: "sources/github/acme/web.md",
          text: "---\nprovider: github\nconnection: con_linear1\nrepository: acme/web\n---\n",
        },
      ],
      connections: fileConnections,
    })
    expect(statuses(rows)).toEqual([
      [
        "sources/github/acme/web.md",
        "invalid",
        expect.stringContaining("linear connection"),
      ],
      ["sources/linear/gone.md", "connection_missing", expect.any(String)],
    ])
  })

  it("passes the path as the key of the access check", async () => {
    const keys: string[] = []
    await planSourceRows({
      text: null,
      files: [githubFile("sources/github/acme/web.md", "acme/web")],
      connections: fileConnections,
      checkAccess: async (entry) => {
        keys.push(entry.key)
        return null
      },
    })
    expect(keys).toEqual(["sources/github/acme/web.md"])
  })

  it("makes a GitHub file that names the Workspace repository invalid", async () => {
    const rows = await planSourceRows({
      text: null,
      files: [githubFile("sources/github/acme/context.md", "Acme/Context")],
      connections: fileConnections,
      workspaceUrl: "https://github.com/acme/context.git",
    })
    expect(statuses(rows)).toEqual([
      [
        "sources/github/acme/context.md",
        "invalid",
        expect.stringContaining("Workspace repository"),
      ],
    ])
  })

  it("keeps the first path in byte order when two files name the same repository", async () => {
    const rows = await planSourceRows({
      text: null,
      files: [
        githubFile("sources/github/acme/web.md", "acme/web"),
        githubFile("sources/github/acme/web-copy.md", "ACME/Web", "main"),
      ],
      connections: fileConnections,
    })
    expect(statuses(rows)).toEqual([
      ["sources/github/acme/web-copy.md", "ok", null],
      [
        "sources/github/acme/web.md",
        "invalid",
        expect.stringContaining("sources/github/acme/web-copy.md"),
      ],
    ])
  })

  it("keeps the row that was ok at the previous revision when a new file names its repository", async () => {
    const rows = await planSourceRows({
      text: null,
      files: [
        githubFile("sources/github/acme/web.md", "acme/web"),
        githubFile("sources/github/acme/a-new.md", "acme/web"),
      ],
      connections: fileConnections,
      previousRows: [
        previousRow("sources/github/acme/web.md", "ok", {
          repository: "acme/web",
        }),
      ],
    })
    expect(statuses(rows)).toEqual([
      [
        "sources/github/acme/a-new.md",
        "invalid",
        expect.stringContaining("sources/github/acme/web.md"),
      ],
      ["sources/github/acme/web.md", "ok", null],
    ])
  })

  it("makes the later of two sources with overlapping managed paths invalid", async () => {
    const rows = await planSourceRows({
      text: null,
      files: [
        linearFile("sources/linear/eng.md", "ENG"),
        linearFile("sources/linear/all.md", "ENG"),
        linearFile("sources/linear/ops.md", "OPS"),
      ],
      connections: fileConnections,
      managedPaths: linearManagedPaths,
    })
    expect(statuses(rows)).toEqual([
      ["sources/linear/all.md", "ok", null],
      [
        "sources/linear/eng.md",
        "invalid",
        expect.stringContaining("sources/linear/all.md"),
      ],
      ["sources/linear/ops.md", "ok", null],
    ])
  })

  it("finds an overlap when one managed path is below the other", async () => {
    const rows = await planSourceRows({
      text: null,
      files: [
        linearFile("sources/linear/a.md", "ENG"),
        linearFile("sources/linear/b.md", "OPS"),
      ],
      connections: fileConnections,
      managedPaths: (entry) =>
        entry.key === "sources/linear/a.md"
          ? ["linear/"]
          : ["linear/teams/OPS/"],
      previousRows: [
        previousRow("sources/linear/b.md", "ok", { teams: ["OPS"] }, "linear"),
      ],
    })
    expect(statuses(rows)).toEqual([
      [
        "sources/linear/a.md",
        "invalid",
        expect.stringContaining("sources/linear/b.md"),
      ],
      ["sources/linear/b.md", "ok", null],
    ])
  })

  it("lets an out_of_access row hold its repository", async () => {
    const rows = await planSourceRows({
      text: null,
      files: [
        githubFile("sources/github/acme/a.md", "acme/web"),
        githubFile("sources/github/acme/b.md", "acme/web"),
      ],
      connections: fileConnections,
      checkAccess: async (entry) =>
        entry.key === "sources/github/acme/a.md" ? "No access" : null,
    })
    expect(statuses(rows)).toEqual([
      ["sources/github/acme/a.md", "out_of_access", "No access"],
      [
        "sources/github/acme/b.md",
        "invalid",
        expect.stringContaining("sources/github/acme/a.md"),
      ],
    ])
  })

  it("keeps the previous winner when it loses access for one revision", async () => {
    const files = [
      githubFile("sources/github/acme/a.md", "acme/web"),
      githubFile("sources/github/acme/b.md", "acme/web"),
    ]
    const rows = await planSourceRows({
      text: null,
      files,
      connections: fileConnections,
      checkAccess: async (entry) =>
        entry.key === "sources/github/acme/b.md" ? "No access" : null,
      previousRows: [
        previousRow("sources/github/acme/a.md", "invalid", {
          repository: "acme/web",
        }),
        previousRow("sources/github/acme/b.md", "ok", {
          repository: "acme/web",
        }),
      ],
    })
    expect(statuses(rows)).toEqual([
      [
        "sources/github/acme/a.md",
        "invalid",
        expect.stringContaining("sources/github/acme/b.md"),
      ],
      ["sources/github/acme/b.md", "out_of_access", "No access"],
    ])
  })

  it("keeps the previous winner when its connection is missing for one revision", async () => {
    const rows = await planSourceRows({
      text: null,
      files: [
        githubFile("sources/github/acme/a.md", "acme/web"),
        {
          path: "sources/github/acme/b.md",
          text: "---\nprovider: github\nconnection: con_gone\nrepository: acme/web\n---\n",
        },
      ],
      connections: fileConnections,
      previousRows: [
        previousRow("sources/github/acme/a.md", "invalid", {}),
        previousRow("sources/github/acme/b.md", "ok", {
          repository: "acme/web",
        }),
      ],
    })
    expect(statuses(rows)).toEqual([
      [
        "sources/github/acme/a.md",
        "invalid",
        expect.stringContaining("sources/github/acme/b.md"),
      ],
      ["sources/github/acme/b.md", "connection_missing", expect.any(String)],
    ])
  })

  it("carries the hold of a source to its new path after a rename", async () => {
    const rows = await planSourceRows({
      text: null,
      files: [
        githubFile("sources/github/acme/b.md", "acme/web"),
        githubFile("sources/github/acme/c.md", "acme/web"),
      ],
      connections: fileConnections,
      previousRows: [
        previousRow("sources/github/acme/a.md", "ok", {
          repository: "acme/web",
        }),
        previousRow("sources/github/acme/b.md", "invalid", {
          repository: "acme/web",
        }),
      ],
    })
    expect(statuses(rows)).toEqual([
      [
        "sources/github/acme/b.md",
        "invalid",
        expect.stringContaining("sources/github/acme/c.md"),
      ],
      ["sources/github/acme/c.md", "ok", null],
    ])
  })

  it("carries the hold of managed paths to the new path after a rename", async () => {
    const rows = await planSourceRows({
      text: null,
      files: [
        linearFile("sources/linear/a.md", "ENG"),
        linearFile("sources/linear/z.md", "ENG"),
      ],
      connections: fileConnections,
      managedPaths: linearManagedPaths,
      previousRows: [
        previousRow(
          "sources/linear/a.md",
          "invalid",
          { teams: ["ENG"] },
          "linear",
        ),
        previousRow(
          "sources/linear/eng.md",
          "ok",
          { teams: ["ENG"] },
          "linear",
        ),
      ],
    })
    expect(statuses(rows)).toEqual([
      [
        "sources/linear/a.md",
        "invalid",
        expect.stringContaining("sources/linear/z.md"),
      ],
      ["sources/linear/z.md", "ok", null],
    ])
  })

  it("keeps a YAML entry that names the Workspace repository ok and skips only that repository", async () => {
    const rows = await planSourceRows({
      text: "version: 1\nsources:\n  - {id: code, provider: github, connection: con_github1, repositories: [acme/context, acme/web, acme/api]}\n",
      connections: fileConnections,
      workspaceUrl: "https://github.com/acme/context.git",
    })
    expect(statuses(rows)).toEqual([["code", "ok", null]])
  })

  it("keeps a later YAML entry ok and skips only its repository that an earlier entry links", async () => {
    const rows = await planSourceRows({
      text: "version: 1\nsources:\n  - {id: web, provider: github, connection: con_github1, repositories: [acme/web]}\n  - {id: apps, provider: github, connection: con_github1, repositories: [acme/web, acme/api]}\n",
      connections: fileConnections,
    })
    expect(statuses(rows)).toEqual([
      ["web", "ok", null],
      ["apps", "ok", expect.stringContaining("web already links")],
    ])
  })

  it("keeps a YAML entry ok and skips its repository that a source file holds", async () => {
    const rows = await planSourceRows({
      text: "version: 1\nsources:\n  - {id: apps, provider: github, connection: con_github1, repositories: [acme/web, acme/api]}\n",
      files: [githubFile("sources/github/acme/web.md", "acme/web")],
      connections: fileConnections,
      previousRows: [
        previousRow("sources/github/acme/web.md", "ok", {
          repository: "acme/web",
        }),
      ],
    })
    expect(statuses(rows)).toEqual([
      [
        "apps",
        "ok",
        expect.stringContaining("sources/github/acme/web.md already links"),
      ],
      ["sources/github/acme/web.md", "ok", null],
    ])
  })

  it("reads the YAML entries and the files together, and applies the rules to both", async () => {
    const rows = await planSourceRows({
      text: "version: 1\nsources:\n  - {id: code, provider: github, connection: con_github1, repositories: [acme/web, acme/api]}\n",
      files: [githubFile("sources/github/acme/web.md", "acme/web")],
      connections: fileConnections,
      previousRows: [
        previousRow("code", "ok", { repositories: ["acme/web", "acme/api"] }),
      ],
    })
    expect(statuses(rows)).toEqual([
      ["code", "ok", null],
      [
        "sources/github/acme/web.md",
        "invalid",
        expect.stringContaining("code"),
      ],
    ])
  })
})

function gitFile(path: string, url: string) {
  return { path, text: `---\nprovider: git\nurl: ${url}\n---\n` }
}

describe("planSourceRows of plain git source files (CTX-815)", () => {
  it("gives an ok row with no connection and no access check", async () => {
    const checked: string[] = []
    const rows = await planSourceRows({
      text: null,
      files: [
        gitFile(
          "sources/git/git.example.org/team-app.md",
          "https://git.example.org/team/app.git",
        ),
      ],
      connections: fileConnections,
      checkAccess: async (entry) => {
        checked.push(entry.key)
        return "no access"
      },
    })
    expect(rows).toEqual([
      {
        sourceKey: "sources/git/git.example.org/team-app.md",
        provider: "git",
        connectionId: null,
        scope: { url: "https://git.example.org/team/app.git" },
        status: "ok",
        statusDetail: null,
      },
    ])
    expect(checked).toEqual([])
  })

  it("makes a plain git file invalid when its URL is refused or names the Workspace repository", async () => {
    const rows = await planSourceRows({
      text: null,
      files: [
        gitFile(
          "sources/git/git.example.org/plain-http.md",
          "http://git.example.org/team/app.git",
        ),
        gitFile(
          "sources/git/github.com/acme-context.md",
          "https://github.com/Acme/Context.git",
        ),
      ],
      connections: fileConnections,
      workspaceUrl: "https://github.com/acme/context",
    })
    expect(statuses(rows)).toEqual([
      [
        "sources/git/git.example.org/plain-http.md",
        "invalid",
        expect.stringContaining("must use HTTPS"),
      ],
      [
        "sources/git/github.com/acme-context.md",
        "invalid",
        expect.stringContaining("Workspace repository"),
      ],
    ])
  })

  it("keeps one source of a repository that a GitHub file and a plain git file both name", async () => {
    const rows = await planSourceRows({
      text: null,
      files: [
        githubFile("sources/github/acme/web.md", "acme/web"),
        gitFile(
          "sources/git/github.com/acme-web.md",
          "https://github.com/acme/web.git",
        ),
      ],
      connections: fileConnections,
    })
    expect(statuses(rows)).toEqual([
      ["sources/git/github.com/acme-web.md", "ok", null],
      [
        "sources/github/acme/web.md",
        "invalid",
        expect.stringContaining("sources/git/github.com/acme-web.md"),
      ],
    ])
  })

  it("makes a plain git file that now names another URL invalid", async () => {
    const rows = await planSourceRows({
      text: null,
      files: [
        gitFile(
          "sources/git/git.example.org/team-app.md",
          "https://git.example.org/team/other.git",
        ),
      ],
      connections: fileConnections,
      previousRows: [
        {
          sourceKey: "sources/git/git.example.org/team-app.md",
          provider: "git",
          connectionId: null,
          scope: { url: "https://git.example.org/team/app.git" },
          status: "ok",
        },
      ],
    })
    expect(statuses(rows)).toEqual([
      [
        "sources/git/git.example.org/team-app.md",
        "invalid",
        expect.stringContaining("names another repository"),
      ],
    ])
  })

  it("refuses a plain git entry in .ctxpipe/sources.yaml", async () => {
    const rows = await planSourceRows({
      text: "version: 1\nsources:\n  - id: plain\n    provider: git\n    connection: con_linear1\n    url: https://git.example.org/team/app.git\n",
      connections: fileConnections,
    })
    expect(statuses(rows)).toEqual([
      ["plain", "invalid", expect.stringContaining("sources/git/")],
    ])
  })
})

describe("unmatchedSourceDetail", () => {
  const plan = (text: string) => planSourceRows({ text, connections })

  it("tells when a missing source can still be in the file", async () => {
    expect(unmatchedSourceDetail(await plan("version: [\n"))).toBe(
      "The sources file cannot be read",
    )
    expect(
      unmatchedSourceDetail(
        await plan(`version: 1
sources:
  - id: Not An Id
    provider: linear
    connection: con_linear1
    teams: [ENG]
`),
      ),
    ).toBe("An entry without a readable id can be this source")
  })

  it("gives null when every entry has a readable id", async () => {
    expect(unmatchedSourceDetail(await plan("version: 1\nsources: []\n"))).toBe(
      null,
    )
    expect(
      unmatchedSourceDetail(
        await plan(`version: 1
sources:
  - id: issues
    provider: linear
    connection: con_linear1
    teams: 5
`),
      ),
    ).toBe(null)
  })
})
