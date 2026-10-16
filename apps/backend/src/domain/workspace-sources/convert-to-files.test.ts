import { describe, expect, it } from "vitest"
import {
  planSourcesConversion,
  type SourcesConversionTree,
} from "./convert-to-files.js"
import { githubSourceRepositories } from "./github-sources.js"
import { resolveSourceRows } from "./projection-plan.js"
import { parseSourceFile } from "./source-file-text.js"

/** The tree after the conversion: the writes and deletes applied. */
function apply(tree: SourcesConversionTree): SourcesConversionTree {
  const plan = planSourcesConversion(tree)
  const files = new Map(tree.sourceFiles.map((file) => [file.path, file.text]))
  for (const write of plan.writes) files.set(write.path, write.content)
  return {
    sourcesYaml: plan.deletes.includes(".ctxpipe/sources.yaml")
      ? null
      : tree.sourcesYaml,
    sourceFiles: [...files].map(([path, text]) => ({ path, text })),
  }
}

/** The rows of the projection, without the key, which changes from id to path. */
function rowsOf(tree: SourcesConversionTree) {
  return resolveSourceRows({
    text: tree.sourcesYaml,
    files: tree.sourceFiles,
    connections: null,
  })
}

function okNonGithub(tree: SourcesConversionTree) {
  return rowsOf(tree)
    .filter((row) => row.status === "ok" && row.provider !== "github")
    .map(({ provider, connectionId, scope }) => ({
      provider,
      connectionId,
      scope,
    }))
}

function linked(tree: SourcesConversionTree) {
  return githubSourceRepositories(tree.sourcesYaml, null, tree.sourceFiles)
    .map(({ gitUrl, ref, connectionId }) => ({ gitUrl, ref, connectionId }))
    .sort((a, b) => a.gitUrl.localeCompare(b.gitUrl))
}

/** The sample of the "Linked repositories" docs page. */
const DOCS_SAMPLE = `version: 1
sources:
  - id: linked-repositories
    provider: github
    connection: con_example
    repositories:
      - acme/checkout-service
      - name: acme/payments
        ref: release
`

/** A Workspace with each provider, as the step 1 export and the UI write it. */
const ALL_PROVIDERS = `version: 1
sources:
  # Incident and release channels.
  - id: incidents
    provider: slack
    connection: con_Sk5mRt2b
    channels: [C0123ABCD, C0456EFGH]
  - id: eng
    provider: linear
    connection: con_Lr81kQe0
    description: Engineering and operations work.
    teams: [ENG, OPS]
    customerRequests: exclude
  - id: handbook
    provider: notion
    connection: con_Nt3pW9za
    pages:
      - id: 1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9
        title: Engineering handbook
  - id: on-call
    provider: pagerduty
    connection: con_Pd9cXy1u
    services: [PSVC001, PSVC002]
  - id: arch
    provider: confluence
    connection: con_Cf4hJk8s
    spaces:
      - key: ARCH
        pages: all
      - key: OPS
        pages: ["12345", "67890"]
  - id: linked-repositories
    provider: github
    connection: con_7Hq2xVn4
    repositories:
      - acme/checkout-api
      - name: Acme/Web.App
        ref: release/2026
`

describe("planSourcesConversion", () => {
  it("changes nothing when the tree has no sources.yaml", () => {
    expect(
      planSourcesConversion({
        sourcesYaml: null,
        sourceFiles: [
          {
            path: "sources/slack/x.md",
            text: "---\nprovider: slack\n---\n",
          },
        ],
      }),
    ).toEqual({ writes: [], deletes: [], report: [] })
  })

  it("gives one file for each repository of the docs sample, with its ref", () => {
    expect(
      planSourcesConversion({ sourcesYaml: DOCS_SAMPLE, sourceFiles: [] }),
    ).toEqual({
      writes: [
        {
          path: "sources/github/acme/checkout-service.md",
          content:
            "---\nprovider: github\nconnection: con_example\nrepository: acme/checkout-service\n---\n",
        },
        {
          path: "sources/github/acme/payments.md",
          content:
            "---\nprovider: github\nconnection: con_example\nrepository: acme/payments\nref: release\n---\n",
        },
      ],
      deletes: [".ctxpipe/sources.yaml"],
      report: [],
    })
  })

  it("keeps each entry, connection, scope, ref, and description of every provider", () => {
    const tree = { sourcesYaml: ALL_PROVIDERS, sourceFiles: [] }
    const plan = planSourcesConversion(tree)
    expect(plan.report).toEqual([])
    expect(plan.writes.map((write) => write.path)).toEqual([
      "sources/confluence/arch.md",
      "sources/github/acme/checkout-api.md",
      "sources/github/acme/web.app.md",
      "sources/linear/eng.md",
      "sources/notion/handbook.md",
      "sources/pagerduty/on-call.md",
      "sources/slack/incidents.md",
    ])
    const bodies = Object.fromEntries(
      plan.writes.map((write) => {
        const parsed = parseSourceFile(write.path, write.content)
        if (!parsed.ok) throw new Error(`${write.path}: ${parsed.detail}`)
        return [write.path, parsed.body]
      }),
    )
    expect(bodies["sources/slack/incidents.md"]).toBe(
      "\nIncident and release channels.\n",
    )
    expect(bodies["sources/linear/eng.md"]).toBe(
      "\nEngineering and operations work.\n",
    )
    expect(bodies["sources/pagerduty/on-call.md"]).toBe("")

    const after = apply(tree)
    expect(okNonGithub(after)).toEqual(
      expect.arrayContaining(okNonGithub(tree)),
    )
    expect(okNonGithub(after)).toHaveLength(5)
    expect(linked(after)).toEqual(linked(tree))
    expect(rowsOf(after).every((row) => row.status === "ok")).toBe(true)
  })

  it("is deterministic and idempotent, also when an old pull request adds sources.yaml again", () => {
    const tree = { sourcesYaml: ALL_PROVIDERS, sourceFiles: [] }
    expect(planSourcesConversion(tree)).toEqual(planSourcesConversion(tree))
    const after = apply(tree)
    expect(planSourcesConversion(after)).toEqual({
      writes: [],
      deletes: [],
      report: [],
    })
    expect(
      planSourcesConversion({ ...after, sourcesYaml: ALL_PROVIDERS }),
    ).toEqual({ writes: [], deletes: [".ctxpipe/sources.yaml"], report: [] })
  })

  it("keeps each invalid entry in an unconverted file with its reason, and it stays invalid", () => {
    const tree = {
      sourcesYaml: `version: 1
sources:
  - id: wrong
    provider: notion
    connection: con_a
  - id: nope
    provider: jira
    connection: con_b
    projects: [X]
  - just a string
  - id: twice
    provider: slack
    connection: con_c
    channels: [C0AAA0001]
  - id: twice
    provider: slack
    connection: con_c
    channels: [C0BBB0001]
  - id: gh
    provider: github
    connection: con_d
    description: Not a key of a GitHub entry.
    repositories: [acme/api]
`,
      sourceFiles: [],
    }
    const plan = planSourcesConversion(tree)
    expect(plan.writes.map((write) => write.path)).toEqual([
      "sources/unconverted/entry-3.md",
      "sources/unconverted/gh.md",
      "sources/unconverted/nope.md",
      "sources/unconverted/twice-2.md",
      "sources/unconverted/twice.md",
      "sources/unconverted/wrong.md",
    ])
    expect(plan.report).toHaveLength(6)
    const wrong = plan.writes.find((write) =>
      write.path.endsWith("/wrong.md"),
    )?.content
    expect(wrong).toContain("id: wrong\nprovider: notion\nconnection: con_a\n")
    expect(wrong).toContain('ctx| did not convert the entry "wrong"')
    const twice = plan.writes.find((write) =>
      write.path.endsWith("/twice-2.md"),
    )?.content
    expect(twice).toContain("C0BBB0001")
    expect(twice).toContain('The id "twice" is used by more than one entry')
    expect(
      plan.writes.find((write) => write.path.endsWith("/entry-3.md"))?.content,
    ).toContain("---\njust a string\n---\n")
    // No entry that was invalid before syncs after the conversion.
    const after = apply(tree)
    expect(rowsOf(after).filter((row) => row.status === "ok")).toEqual([])
    expect(rowsOf(after)).toHaveLength(6)
  })

  it("keeps a sources file that cannot be read as text in one unconverted file", () => {
    const text = "version: [\n  ~~~ text\n"
    const plan = planSourcesConversion({ sourcesYaml: text, sourceFiles: [] })
    expect(plan.deletes).toEqual([".ctxpipe/sources.yaml"])
    expect(plan.writes).toHaveLength(1)
    expect(plan.writes[0]?.path).toBe("sources/unconverted/sources-yaml.md")
    expect(plan.writes[0]?.content).toContain(`~~~~yaml\n${text}~~~~\n`)
    expect(plan.report[0]).toMatch(
      /^the full file went to sources\/unconverted\/sources-yaml.md: The file is not valid YAML/,
    )
    const notVersion1 = planSourcesConversion({
      sourcesYaml: "version: 2\nsources: []\n",
      sourceFiles: [],
    })
    expect(notVersion1.writes[0]?.content).toContain(
      "The file does not match version 1",
    )
  })

  it("keeps an existing file, skips the same source, and gives a different source a free path", () => {
    const existing = [
      {
        path: "sources/slack/incidents.md",
        text: "---\nprovider: slack\nconnection: con_Sk5mRt2b\nchannels: [C0123ABCD, C0456EFGH]\n---\n\nPeople wrote this.\n",
      },
      {
        path: "sources/linear/eng.md",
        text: "---\nprovider: linear\nconnection: con_other\nteams: [SUP]\n---\n",
      },
      {
        path: "sources/linear/eng-2.md",
        text: "not a source file",
      },
      // A person named this file after the repository acme/checkout-api,
      // but it links another repository.
      {
        path: "sources/github/acme/checkout-api.md",
        text: "---\nprovider: github\nconnection: con_7Hq2xVn4\nrepository: acme/legacy\n---\n",
      },
    ]
    const tree = { sourcesYaml: ALL_PROVIDERS, sourceFiles: existing }
    const plan = planSourcesConversion(tree)
    const paths = plan.writes.map((write) => write.path)
    expect(paths).not.toContain("sources/slack/incidents.md")
    expect(paths).not.toContain("sources/linear/eng.md")
    expect(paths).toContain("sources/linear/eng-3.md")
    expect(paths).toContain("sources/github/acme/checkout-api-2.md")
    expect(plan.report).toEqual([])
    const after = apply(tree)
    expect(linked(after)).toEqual(linked(tree))
    expect(
      planSourcesConversion({ ...after, sourcesYaml: ALL_PROVIDERS }),
    ).toEqual({ writes: [], deletes: [".ctxpipe/sources.yaml"], report: [] })
  })

  it("does not give a second active file to a repository that a file or an earlier entry links", () => {
    const tree = {
      sourcesYaml: `version: 1
sources:
  - id: first
    provider: github
    connection: con_a
    repositories: [acme/api, acme/web, acme/docs]
  - id: second
    provider: github
    connection: con_a
    repositories:
      - acme/api
      - name: acme/web
        ref: next
`,
      sourceFiles: [
        {
          path: "sources/github/acme/documentation.md",
          text: "---\nprovider: github\nconnection: con_a\nrepository: acme/docs\nref: main\n---\n",
        },
      ],
    }
    const plan = planSourcesConversion(tree)
    expect(plan.writes.map((write) => write.path)).toEqual([
      "sources/github/acme/api.md",
      "sources/github/acme/web.md",
      "sources/unconverted/github-acme-docs.md",
      "sources/unconverted/github-acme-web.md",
    ])
    expect(plan.report).toEqual([
      'acme/docs in the entry "first" went to sources/unconverted/github-acme-docs.md: sources/github/acme/documentation.md already links acme/docs',
      'acme/web in the entry "second" went to sources/unconverted/github-acme-web.md: sources/github/acme/web.md already links acme/web',
    ])
    // The existing file keeps acme/docs (CTX-721 plan, conversion step 5).
    // Before, the winner of acme/docs came from the previous rows.
    expect(linked(apply(tree))).toEqual([
      {
        gitUrl: "https://github.com/acme/api",
        ref: null,
        connectionId: "con_a",
      },
      {
        gitUrl: "https://github.com/acme/docs",
        ref: "main",
        connectionId: "con_a",
      },
      {
        gitUrl: "https://github.com/acme/web",
        ref: null,
        connectionId: "con_a",
      },
    ])
  })

  it("names a repository whose name is not a path segment, and reports comments that are not above an entry", () => {
    const plan = planSourcesConversion({
      sourcesYaml: `# The sources of this Workspace.
version: 1
sources:
  - id: gh
    provider: github
    connection: con_a
    repositories: [acme/api.lock, acme/.github]
# The end.
`,
      sourceFiles: [],
    })
    expect(plan.writes.map((write) => write.path)).toEqual([
      "sources/github/acme/api-lock.md",
      "sources/github/acme/dot-github.md",
    ])
    expect(plan.report).toEqual([
      ".ctxpipe/sources.yaml had comments that are not above an entry, and they are not converted:\n> The sources of this Workspace.\n> The end.",
    ])
  })
})
