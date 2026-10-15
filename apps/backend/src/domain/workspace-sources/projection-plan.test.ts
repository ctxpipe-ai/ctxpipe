import { describe, expect, it } from "vitest"
import { FILE_ERROR_SOURCE_KEY, planSourceRows } from "./projection-plan.js"

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
          "repositories/tools.md: ctx| links only GitHub repositories. Move the link into .ctxpipe/sources.yaml or remove the file.",
      },
    ])
  })
})
