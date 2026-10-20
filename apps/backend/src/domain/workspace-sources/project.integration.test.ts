import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { lastGoodTarget } from "../../models/workspace-source-state.js"
import { listWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { projectWorkspaceSources } from "./project.js"

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>

describe("projectWorkspaceSources (Postgres + git)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("wsrc_project")
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  it("follows the file through revisions, with a status for each bad entry", async () => {
    const env = parseEnv(process.env)
    // Slack has no setup-draft state, so listOrgConnections keeps it.
    const slack = await seed.addConnection("slack")
    const forge = await seed.addConnection("forge")
    const workspaceId = await seed.addWorkspace("docs")
    const repo = await seed.gitRepository()
    const project = async (sha: string) =>
      projectWorkspaceSources({
        orgId: seed.orgId,
        workspaceId,
        revision: sha,
        text: await repo.sourcesText(sha),
        env,
        adapters: {
          confluence: {
            provider: "confluence",
            managedPaths: () => ["confluence/"],
            fetch: async () => [],
            checkAccess: async () => "Space ENG is not in this site",
          },
        },
      })
    const rows = () =>
      listWorkspaceSourceRows({ orgId: seed.orgId, workspaceId })

    const noFile = await repo.commit({ "AGENTS.md": "# Docs\n" })
    await project(noFile)
    expect(await rows()).toEqual([])

    const first = await repo.commit({
      ".ctxpipe/sources.yaml": `version: 1
sources:
  - id: eng-issues
    provider: slack
    connection: ${slack}
    channels: [C0ENG0001]
  - id: eng-docs
    provider: confluence
    connection: ${forge}
    spaces: [{ key: ENG, pages: all }]
  - id: wrong
    provider: notion
    connection: ${slack}
  - id: unknown
    provider: linear
    connection: con_doesnotexist
    teams: [ENG]
`,
    })
    const added = await project(first)
    expect(added.added).toHaveLength(4)
    expect(
      (await rows()).map((row) => [row.sourceKey, row.status, row.revision]),
    ).toEqual([
      ["eng-docs", "out_of_access", first],
      ["eng-issues", "ok", first],
      ["unknown", "connection_missing", first],
      ["wrong", "invalid", first],
    ])

    expect(await project(first)).toEqual({
      added: [],
      changed: [],
      removed: [],
    })

    const second = await repo.commit({
      ".ctxpipe/sources.yaml": `version: 1
sources:
  - id: eng-issues
    provider: slack
    connection: ${slack}
    channels: [C0ENG0001, C0OPS0001]
`,
    })
    const next = await project(second)
    expect(next.removed.map((row) => row.sourceKey).sort()).toEqual([
      "eng-docs",
      "unknown",
      "wrong",
    ])
    expect(next.changed.map((change) => change.before.scope)).toEqual([
      { channels: ["C0ENG0001"] },
    ])

    const broken = await repo.commit({
      ".ctxpipe/sources.yaml": "version: [\n",
    })
    await project(broken)
    // The file may still have `eng-issues`, so its row stays, with its last
    // good scope, until the file can be read again.
    expect(
      (await rows())
        .map((row) => [
          row.sourceKey,
          row.status,
          row.statusDetail,
          lastGoodTarget(row)?.scope ?? null,
        ])
        .sort(),
    ).toEqual([
      [".file", "invalid", expect.any(String), null],
      [
        "eng-issues",
        "invalid",
        "The sources file cannot be read",
        { channels: ["C0ENG0001", "C0OPS0001"] },
      ],
    ])
    expect(await project(broken)).toEqual({
      removed: [],
      changed: [],
      added: [],
    })

    const removed = await repo.commit({ ".ctxpipe/sources.yaml": null })
    await project(removed)
    expect(await rows()).toEqual([])
  })

  it("follows the files under sources/ through add, change, rename, and delete, and keeps each GitHub pin by repository and ref", async () => {
    const env = parseEnv(process.env)
    const slack = await seed.addConnection("slack")
    // No installation: the access check finds no coverage and asks no API.
    const github = await seed.addConnection("github")
    const workspaceId = await seed.addWorkspace("files")
    const repo = await seed.gitRepository()
    const project = async (sha: string) => {
      const tree = await repo.sourcesTree(sha)
      // Hydrate projects in the org context; the GitHub access check needs it.
      return withOrgIdContext({ id: seed.orgId, slug: seed.orgId }, () =>
        projectWorkspaceSources({
          orgId: seed.orgId,
          workspaceId,
          revision: sha,
          text: tree.sourcesFile,
          files: tree.sourceFiles,
          env,
          adapters: {
            slack: {
              provider: "slack",
              managedPaths: (scope) =>
                ((scope as { channels: string[] }).channels ?? []).map(
                  (channel) => `slack/channels/${channel}/`,
                ),
              fetch: async () => [],
            },
          },
        }),
      )
    }
    const rows = () =>
      listWorkspaceSourceRows({ orgId: seed.orgId, workspaceId })
    const repository = `acme/web-${seed.suffix.replaceAll("_", "-")}`
    const githubText = (ref?: string) =>
      `---\nprovider: github\nconnection: ${github}\nrepository: ${repository}\n${ref ? `ref: ${ref}\n` : ""}---\n\nThe web app.\n`
    const slackText = (channels: string) =>
      `---\nprovider: slack\nconnection: ${slack}\nchannels: [${channels}]\n---\n`
    const pinOf = async (sourceKey: string) => {
      const row = (await rows()).find((item) => item.sourceKey === sourceKey)
      return (row?.state as { repositories?: Array<Record<string, unknown>> })
        ?.repositories?.[0]
    }

    const first = await repo.commit({
      "sources/github/acme/web.md": githubText(),
      "sources/slack/incidents.md": slackText("C0ENG0001"),
      "sources/slack/notes.txt": "not a source\n",
    })
    expect((await project(first)).added).toHaveLength(3)
    expect(
      (await rows()).map((row) => [row.sourceKey, row.status, row.provider]),
    ).toEqual([
      ["sources/github/acme/web.md", "ok", "github"],
      ["sources/slack/incidents.md", "ok", "slack"],
      ["sources/slack/notes.txt", "invalid", null],
    ])
    const pin = await pinOf("sources/github/acme/web.md")
    expect(pin?.id).toMatch(/^wlr_/)
    // The tip check and the index set the SHAs of a pin.
    await withOrgDbContext(seed.orgId, (db) =>
      db
        .update(workspaceSources)
        .set({
          state: {
            provider: "github",
            repositories: [
              {
                ...pin,
                desiredSha: "a".repeat(40),
                indexedSha: "a".repeat(40),
              },
            ],
          },
        })
        .where(
          and(
            eq(workspaceSources.workspaceId, workspaceId),
            eq(workspaceSources.sourceKey, "sources/github/acme/web.md"),
          ),
        ),
    )
    expect(await project(first)).toEqual({
      added: [],
      changed: [],
      removed: [],
    })

    // Change one file.
    const changed = await repo.commit({
      "sources/slack/incidents.md": slackText("C0ENG0001, C0OPS0001"),
      "sources/slack/notes.txt": null,
    })
    const afterChange = await project(changed)
    expect(
      afterChange.changed.map((change) => change.before.sourceKey),
    ).toEqual(["sources/slack/incidents.md"])
    expect(afterChange.removed.map((row) => row.sourceKey)).toEqual([
      "sources/slack/notes.txt",
    ])

    // Rename the GitHub file: the new path keeps the wlr id and the SHAs.
    const renamed = await repo.commit({
      "sources/github/acme/web.md": null,
      "sources/github/acme/frontend.md": githubText(),
    })
    const afterRename = await project(renamed)
    expect(afterRename.removed.map((row) => row.sourceKey)).toEqual([
      "sources/github/acme/web.md",
    ])
    expect(await pinOf("sources/github/acme/frontend.md")).toEqual({
      ...pin,
      desiredSha: "a".repeat(40),
      indexedSha: "a".repeat(40),
    })

    // A new file for the same repository loses to the row that was ok.
    const copied = await repo.commit({
      "sources/github/acme/a-copy.md": githubText(),
    })
    await project(copied)
    expect(
      (await rows()).map((row) => [
        row.sourceKey,
        row.status,
        row.statusDetail,
      ]),
    ).toEqual([
      [
        "sources/github/acme/a-copy.md",
        "invalid",
        "sources/github/acme/frontend.md already links this repository",
      ],
      ["sources/github/acme/frontend.md", "ok", null],
      ["sources/slack/incidents.md", "ok", null],
    ])

    // A changed ref gets a new id and no SHAs.
    const reffed = await repo.commit({
      "sources/github/acme/a-copy.md": null,
      "sources/github/acme/frontend.md": githubText("release"),
    })
    await project(reffed)
    const next = await pinOf("sources/github/acme/frontend.md")
    expect(next).toMatchObject({
      ref: "release",
      desiredSha: null,
      indexedSha: null,
    })
    expect(next?.id).not.toBe(pin?.id)

    // Delete every file.
    const removed = await repo.commit({
      "sources/github/acme/frontend.md": null,
      "sources/slack/incidents.md": null,
    })
    await project(removed)
    expect(await rows()).toEqual([])
  })
})
