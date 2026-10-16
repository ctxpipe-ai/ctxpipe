import { and, eq } from "drizzle-orm"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import {
  githubPins,
  lastGoodTarget,
} from "../../models/workspace-source-state.js"
import { listWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { closeOpenWorkflowClient } from "../../openworkflow/client.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { planSourcesConversion } from "./convert-to-files.js"
import { enqueueSourceProjectionFollowUps } from "./enqueue.js"
import { projectWorkspaceSources } from "./project.js"

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let backend: BackendPostgres

describe("planSourcesConversion (Postgres + git round trip)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required: run pnpm dev:infra")
    seed = await seedSourcesOrg("wsrc_convert")
    backend = await BackendPostgres.connect(process.env.DATABASE_URL, {
      runMigrations: false,
      namespaceId: openWorkflowNamespaceId(),
    })
  })
  afterAll(async () => {
    await closeOpenWorkflowClient()
    await backend?.stop()
    await seed.cleanup()
  })

  it("projects the converted tree to the same sources and keeps each GitHub pin", async () => {
    const env = parseEnv(process.env)
    const slack = await seed.addConnection("slack")
    // No installation: the access check finds no coverage and asks no API.
    const github = await seed.addConnection("github")
    const workspaceId = await seed.addWorkspace("convert")
    const repo = await seed.gitRepository()
    const project = async (sha: string) => {
      const tree = await repo.sourcesTree(sha)
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
    const owner = `acme-${seed.suffix.replaceAll("_", "-")}`.slice(0, 39)

    const yaml = await repo.commit({
      ".ctxpipe/sources.yaml": `version: 1
sources:
  # Incident channels.
  - id: incidents
    provider: slack
    connection: ${slack}
    channels: [C0ENG0001]
  - id: linked-repositories
    provider: github
    connection: ${github}
    repositories:
      - ${owner}/api
      - name: ${owner}/web
        ref: release
  - id: broken
    provider: notion
    connection: ${slack}
`,
    })
    await project(yaml)
    const before = await rows()
    // The tip check and the index set the SHAs of each pin.
    const linkedRow = before.find(
      (row) => row.sourceKey === "linked-repositories",
    )
    const pinned = (linkedRow ? githubPins(linkedRow) : []).map((pin) => ({
      ...pin,
      desiredSha: "a".repeat(40),
      indexedSha: "b".repeat(40),
    }))
    expect(pinned).toHaveLength(2)
    await withOrgDbContext(seed.orgId, (db) =>
      db
        .update(workspaceSources)
        .set({ state: { provider: "github", repositories: pinned } })
        .where(
          and(
            eq(workspaceSources.workspaceId, workspaceId),
            eq(workspaceSources.sourceKey, "linked-repositories"),
          ),
        ),
    )

    const tree = await repo.sourcesTree(yaml)
    const plan = planSourcesConversion({
      sourcesYaml: tree.sourcesFile,
      sourceFiles: tree.sourceFiles,
    })
    const converted = await repo.commit({
      ...Object.fromEntries(plan.writes.map((w) => [w.path, w.content])),
      ...Object.fromEntries(plan.deletes.map((path) => [path, null])),
    })
    await project(converted)
    const after = await rows()

    expect(
      after.map((row) => [row.sourceKey, row.provider, row.status]),
    ).toEqual([
      [`sources/github/${owner}/api.md`, "github", "ok"],
      [`sources/github/${owner}/web.md`, "github", "ok"],
      ["sources/slack/incidents.md", "slack", "ok"],
      ["sources/unconverted/broken.md", "notion", "invalid"],
    ])
    const slackOf = (list: typeof before) =>
      list
        .filter((row) => row.provider === "slack")
        .map(({ connectionId, scope, status }) => ({
          connectionId,
          scope,
          status,
        }))
    expect(slackOf(after)).toEqual(slackOf(before))
    const pinsAfter = after.flatMap((row) => githubPins(row))
    expect(
      [...pinsAfter].sort((a, b) => a.gitUrl.localeCompare(b.gitUrl)),
    ).toEqual([...pinned].sort((a, b) => a.gitUrl.localeCompare(b.gitUrl)))
    expect(before.find((row) => row.sourceKey === "broken")?.status).toBe(
      "invalid",
    )

    // A second run on the converted tree makes no change and no commit.
    const again = await repo.sourcesTree(converted)
    expect(
      planSourcesConversion({
        sourcesYaml: again.sourcesFile,
        sourceFiles: again.sourceFiles,
      }),
    ).toEqual({ writes: [], deletes: [], report: [] })
  })
  it("queues no cleanup and no retraction when the conversion moves a broken entry and a large description", async () => {
    const env = parseEnv(process.env)
    const linear = await seed.addConnection("linear", {
      status: "installed",
      workspaceId: "linear-org",
      workspaceName: "Example",
    })
    const workspaceId = await seed.addWorkspace("convert-held")
    const repo = await seed.gitRepository()
    const project = async (sha: string) => {
      const tree = await repo.sourcesTree(sha)
      const projected = await withOrgIdContext(
        { id: seed.orgId, slug: seed.orgId },
        () =>
          projectWorkspaceSources({
            orgId: seed.orgId,
            workspaceId,
            revision: sha,
            text: tree.sourcesFile,
            files: tree.sourceFiles,
            env,
            // No access check: the Linear API is not part of this test.
            adapters: {
              linear: {
                provider: "linear",
                managedPaths: (scope) =>
                  ((scope as { teams?: string[] }).teams ?? []).map(
                    (team) => `linear/${team.toLowerCase()}/`,
                  ),
                fetch: async () => [],
              },
            },
          }),
      )
      // A queued retraction needs a writable Workspace, so a retraction
      // makes this call fail.
      await enqueueSourceProjectionFollowUps({
        orgId: seed.orgId,
        workspaceId,
        revision: sha,
        projected,
        publishPipeline: "v2",
      })
    }
    const cleanups = async () =>
      (await backend.listWorkflowRuns({ limit: 1000 })).data
        .map((run) => run.input as Record<string, unknown>)
        .filter(
          (input) =>
            input.kind === "cleanup" && input.workspaceId === workspaceId,
        )
    const rows = () =>
      listWorkspaceSourceRows({ orgId: seed.orgId, workspaceId })
    const description = "Release work. ".repeat(5 * 1024)
    const yaml = (engTeams: string) => `version: 1
sources:
  - id: eng
    provider: linear
    connection: ${linear}
    teams: ${engTeams}
  - id: ops
    provider: linear
    connection: ${linear}
    description: ${description}
    teams: [OPS]
`
    // The synced files of both sources are in git.
    await project(
      await repo.commit({
        ".ctxpipe/sources.yaml": yaml("[ENG]"),
        "linear/eng/ENG-1.md": "# ENG-1\n",
        "linear/ops/OPS-1.md": "# OPS-1\n",
      }),
    )
    // The entry breaks; its row keeps the last good target.
    const broken = await repo.commit({ ".ctxpipe/sources.yaml": yaml("ENG") })
    await project(broken)
    expect(await cleanups()).toEqual([])

    const tree = await repo.sourcesTree(broken)
    const plan = planSourcesConversion({
      sourcesYaml: tree.sourcesFile,
      sourceFiles: tree.sourceFiles,
    })
    await project(
      await repo.commit({
        ...Object.fromEntries(plan.writes.map((w) => [w.path, w.content])),
        ...Object.fromEntries(plan.deletes.map((path) => [path, null])),
      }),
    )

    expect(await cleanups()).toEqual([])
    const after = await rows()
    expect(
      after.map((row) => [row.sourceKey, row.status, lastGoodTarget(row)]),
    ).toEqual([
      [
        "sources/linear/ops.md",
        "ok",
        { provider: "linear", connectionId: linear, scope: { teams: ["OPS"] } },
      ],
      [
        "sources/unconverted/eng.md",
        "invalid",
        { provider: "linear", connectionId: linear, scope: { teams: ["ENG"] } },
      ],
      ["sources/unconverted/linear-ops-description.md", "invalid", null],
    ])
  })
})
