import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { packRoots } from "../../domain/ingestion/ingestion-plan.js"
import { reingestRunKey } from "../../domain/upgrades/reingest.js"
import { generateObjectId } from "../../lib/id.js"
import { insertWorkspaceUpgradeRow } from "../../models/workspace-upgrades.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { insertProjectedSourceRows } from "../../test/workspace-links-fixture.js"
import {
  orgWorkspaceIngestionRoutes,
  workspaceIngestionRoutes,
} from "./workspace-ingestion-routes.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
// A PR number of its own gives this file its own OpenWorkflow namespace.
const pr = `pr-${Date.now()}${Math.floor(Math.random() * 1000)}`
const namespace = `preview-${pr}`

const org = {
  id: `org_test_ingesting_${suffix}`,
  slug: `ingesting-${suffix}`,
  name: "Ingesting",
}
const otherOrg = {
  id: `org_test_ingesting_other_${suffix}`,
  slug: `ingesting-other-${suffix}`,
  name: "Ingesting other",
}
const busy = `ws_busy_${suffix}`
const quiet = `ws_quiet_${suffix}`
const stale = `ws_stale_${suffix}`
const steady = `ws_steady_${suffix}`
// Below format 3: ingestion v2 does not publish to it (`resolve` leaves it out).
const legacy = `ws_legacy_${suffix}`
const repositoryId = `repo_web_${suffix}`
const foreign = `ws_foreign_${suffix}`
const linear = `con_linear_${suffix}`
const repositoryUrl = `https://github.com/acme/web-${suffix}`
const reingestKey = "reingest-bundle-2"

type Item = {
  id: string
  kind: string
  name: string
  stage: string
  progress: { done: number; total: number; unit: string } | null
  startedAt: string
}

async function insertRun(input: {
  id: string
  name: string
  status?: string
  /** A negative age is in the future, so the run never gets old in the test. */
  ageSeconds: number
  input: Record<string, unknown>
  idempotencyKey?: string
}) {
  await getSystemDb().execute(sql`
    insert into openworkflow.workflow_runs
      (namespace_id, id, workflow_name, status, idempotency_key, config,
       input, attempts, available_at, created_at, updated_at)
    values
      (${namespace}, ${input.id}, ${input.name}, ${input.status ?? "running"},
       ${input.idempotencyKey ?? null}, '{}'::jsonb,
       ${JSON.stringify(input.input)}::jsonb, 1, now(),
       now() - ${input.ageSeconds} * interval '1 second', now())
  `)
}

let stepOrder = 0
async function insertStep(
  runId: string,
  name: string,
  status: string,
  output: unknown = null,
) {
  stepOrder += 1
  await getSystemDb().execute(sql`
    insert into openworkflow.step_attempts
      (namespace_id, id, workflow_run_id, step_name, kind, status, config,
       output, created_at, updated_at)
    values
      (${namespace}, ${generateObjectId("step")}, ${runId}, ${name},
       'function', ${status}, '{}'::jsonb, ${JSON.stringify(output)}::jsonb,
       now() - interval '1 hour' + ${stepOrder} * interval '1 second', now())
  `)
}

function v2Input(orgId: string, destinations?: string[]) {
  return {
    orgId,
    shadow: false,
    source: { url: repositoryUrl, githubConnectionId: `con_gh_${suffix}` },
    sha: "a".repeat(40),
    authorTime: "2026-10-21T10:00:00.000Z",
    ...(destinations ? { destinations } : {}),
  }
}

async function readWorkspace(slug: string): Promise<Item[]> {
  const response = await withOrgDbContext(org.id, async () =>
    workspaceHttpApp(org, workspaceIngestionRoutes).request(
      `/workspaces/${slug}/ingestion`,
    ),
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { items: Item[] }).items
}

describe("Active ingestion of a Workspace (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", pr)
    await withOrgDbContext(org.id, async (db) => {
      await db.insert(workspaces).values(
        (
          [
            [busy, "busy", 3],
            [quiet, "quiet", 3],
            [stale, "stale", 3],
            [steady, "steady", 3],
            [legacy, "legacy", 2],
          ] as const
        ).map(([id, slug, formatVersion]) => ({
          id,
          orgId: org.id,
          slug,
          displayName: id,
          workspaceRepositoryUrl: `https://github.com/example/${id}.git`,
          formatVersion,
        })),
      )
      await db.insert(repositories).values({
        id: repositoryId,
        orgId: org.id,
        name: `acme/web-${suffix}`,
        gitUrl: `${repositoryUrl}.git`,
      })
      await insertProjectedSourceRows(db, [
        {
          id: generateObjectId("wsrc"),
          orgId: org.id,
          workspaceId: legacy,
          sourceKey: `sources/github/acme/web-${suffix}.md`,
          provider: "github",
          connectionId: `con_gh_${suffix}`,
          scope: { repositories: [`acme/web-${suffix}`] },
          status: "ok",
          statusDetail: null,
          revision: "fixture",
        },
        {
          id: generateObjectId("wsrc"),
          orgId: org.id,
          workspaceId: busy,
          sourceKey: `sources/github/acme/web-${suffix}.md`,
          provider: "github",
          connectionId: `con_gh_${suffix}`,
          scope: { repositories: [`acme/web-${suffix}`] },
          status: "ok",
          statusDetail: null,
          revision: "fixture",
        },
        {
          id: generateObjectId("wsrc"),
          orgId: org.id,
          workspaceId: busy,
          sourceKey: "sources/linear/team.md",
          provider: "linear",
          connectionId: linear,
          scope: { teams: ["ENG"] },
          status: "ok",
          statusDetail: null,
          revision: "fixture",
        },
      ])
    })
    await withOrgDbContext(otherOrg.id, (db) =>
      db.insert(workspaces).values({
        id: foreign,
        orgId: otherOrg.id,
        slug: "busy",
        displayName: foreign,
        workspaceRepositoryUrl: `https://github.com/example/${foreign}.git`,
        formatVersion: 3,
      }),
    )
    await withOrgIdContext(org, () =>
      insertWorkspaceUpgradeRow({
        workspaceId: busy,
        generation: 1,
        status: "running",
        upgrade: {
          key: reingestKey,
          fromFormat: 3,
          targetFormat: 3,
          repositories: [
            {
              repository: `acme/web-${suffix}`,
              sha: "a".repeat(40),
              runId: "run_shards",
              status: "done",
              report: [],
            },
            {
              repository: "acme/api",
              sha: null,
              runId: null,
              status: "pending",
              report: [],
            },
          ],
        },
      }),
    )

    // A run in its shards: 45 roots make 3 shards, and 2 are done.
    await insertRun({
      id: "run_shards",
      name: "repository-ingestion-v2",
      ageSeconds: 600,
      input: v2Input(org.id),
    })
    await insertStep("run_shards", "publish-turn-deadline", "completed", {
      deadlineAt: 0,
    })
    await insertStep("run_shards", "publish-turn:0", "completed", {
      turn: true,
    })
    // The `resolve` step leaves out the Workspace below format 3.
    await insertStep("run_shards", "resolve", "completed", {
      sourceRepositoryId: repositoryId,
      destinations: [{ workspaceId: busy, generation: 1, sourcePath: "x" }],
      needsUpgrade: [legacy],
    })
    await insertStep("run_shards", "discover-roots", "completed", {
      bundle: "b",
      roots: packRoots(
        Array.from({ length: 45 }, (_, i) => ({
          path: `pkg/${i}`,
          manifests: [],
          evidence: [],
        })),
      ),
      repositorySkills: 1,
    })
    await insertStep("run_shards", "shard:0", "completed", {})
    await insertStep("run_shards", "shard:1", "completed", {})
    await insertStep("run_shards", "shard:2", "running")

    // A later run of the same repository waits for the turn (CTX-964).
    await insertRun({
      id: "run_waiting",
      name: "repository-ingestion-v2",
      status: "sleeping",
      ageSeconds: 300,
      input: v2Input(org.id),
    })
    await insertStep("run_waiting", "publish-turn-deadline", "completed", {
      deadlineAt: 0,
    })
    await insertStep("run_waiting", "publish-turn:0", "completed", {
      wait: "An earlier ingestion run of this source publishes to the same Workspace.",
      expired: false,
    })
    await insertStep("run_waiting", "wait-publish-turn:0", "running")

    await insertRun({
      id: "run_shadow",
      name: "repository-ingestion-v2",
      ageSeconds: 200,
      input: { ...v2Input(org.id), shadow: true },
    })
    await insertRun({
      id: "run_done",
      name: "repository-ingestion-v2",
      status: "completed",
      ageSeconds: 200,
      input: v2Input(org.id),
    })
    await insertRun({
      id: "run_sync",
      name: "workspace-sources-sync",
      status: "pending",
      ageSeconds: 100,
      input: {
        kind: "connection",
        orgId: org.id,
        connectionId: linear,
        provider: "linear",
      },
    })
    await insertRun({
      id: "run_reingest",
      name: "workspace-upgrade-reingest",
      ageSeconds: 900,
      input: { orgId: org.id, workspaceId: busy, key: reingestKey },
    })
    // The ingestion v2 run that the re-ingestion started for one repository.
    await insertRun({
      id: "run_reingest_child",
      name: "repository-ingestion-v2",
      ageSeconds: 800,
      input: v2Input(org.id, [busy]),
      idempotencyKey: reingestRunKey({
        orgId: org.id,
        workspaceId: busy,
        upgradeRunId: "run_reingest",
        repository: `acme/web-${suffix}`,
      }),
    })
    // The code index of the repository runs before ingestion v2.
    await insertRun({
      id: "run_index",
      name: "repository-ingestion",
      ageSeconds: 700,
      input: { orgId: org.id, repositoryId },
    })
    // A hydrate of the newest commit that takes 2 minutes shows; a fast one
    // does not.
    await insertRun({
      id: "run_hydrate_slow",
      name: "workspace-hydrate",
      ageSeconds: 120,
      input: { orgId: org.id, workspaceId: busy },
    })
    await insertRun({
      id: "run_hydrate_fast",
      name: "workspace-hydrate",
      ageSeconds: -3600,
      input: { orgId: org.id, workspaceId: quiet },
    })
    // Runs older than one day, and hydrates older than three hours, are
    // stuck: they do not count.
    await insertRun({
      id: "run_stuck",
      name: "repository-ingestion-v2",
      ageSeconds: 25 * 3600,
      input: v2Input(org.id, [stale]),
    })
    await insertRun({
      id: "run_hydrate_stuck",
      name: "workspace-hydrate",
      ageSeconds: 3.5 * 3600,
      input: { orgId: org.id, workspaceId: stale },
    })
    await insertRun({
      id: "run_long",
      name: "repository-ingestion-v2",
      ageSeconds: 23 * 3600,
      input: v2Input(org.id, [steady]),
    })
    await insertRun({
      id: "run_hydrate_long",
      name: "workspace-hydrate",
      ageSeconds: 2.5 * 3600,
      input: { orgId: org.id, workspaceId: steady },
    })
    // A root list that does not unzip hides only the progress of its run.
    await insertRun({
      id: "run_corrupt",
      name: "repository-ingestion-v2",
      ageSeconds: 400,
      input: v2Input(org.id, [steady]),
    })
    await insertStep("run_corrupt", "discover-roots", "completed", {
      roots: Buffer.from("not gzip").toString("base64"),
    })
    await insertStep("run_corrupt", "shard:0", "running")
    // Many newer shadow runs and fast hydrates (in the future, so they stay
    // newer and fast for the whole test) do not push the real runs out
    // of the limit of 200.
    await getSystemDb().execute(sql`
      insert into openworkflow.workflow_runs
        (namespace_id, id, workflow_name, status, config, input, attempts,
         available_at, created_at, updated_at)
      select ${namespace}, 'run_noise_shadow_' || n, 'repository-ingestion-v2',
        'running', '{}'::jsonb,
        ${JSON.stringify({ ...v2Input(org.id), shadow: true })}::jsonb, 1,
        now(), now() + interval '1 hour', now()
      from generate_series(1, 250) n
      union all
      select ${namespace}, 'run_noise_hydrate_' || n, 'workspace-hydrate',
        'running', '{}'::jsonb,
        jsonb_build_object('orgId', ${org.id}::text,
          'workspaceId', 'ws_noise_' || n),
        1, now(), now() + interval '1 hour', now()
      from generate_series(1, 250) n
    `)
    // The other org has a run that names a Workspace id of this org.
    await insertRun({
      id: "run_foreign",
      name: "repository-ingestion-v2",
      ageSeconds: 50,
      input: v2Input(otherOrg.id, [busy, foreign]),
    })
  })

  afterAll(async () => {
    await getSystemDb().execute(
      sql`delete from openworkflow.step_attempts where namespace_id = ${namespace}`,
    )
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where namespace_id = ${namespace}`,
    )
    await withOrgDbContext(org.id, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.orgId, org.id))
      await db.delete(repositories).where(eq(repositories.orgId, org.id))
    })
    await withOrgDbContext(otherOrg.id, (db) =>
      db.delete(workspaces).where(eq(workspaces.orgId, otherOrg.id)),
    )
    vi.unstubAllEnvs()
    await closeDb()
  })

  it("lists each active run of the Workspace with its stage and progress, oldest first", async () => {
    const items = await readWorkspace("busy")
    expect(
      items.map(({ id, kind, name, stage, progress }) => ({
        id,
        kind,
        name,
        stage,
        progress,
      })),
    ).toEqual([
      {
        id: "run_reingest",
        kind: "reingest",
        name: reingestKey,
        stage: null,
        progress: { done: 1, total: 2, unit: "repositories" },
      },
      {
        id: "run_reingest_child",
        kind: "repository",
        name: `acme/web-${suffix}`,
        stage: "queued",
        progress: null,
      },
      {
        id: "run_index",
        kind: "repository",
        name: `acme/web-${suffix}`,
        stage: "indexing",
        progress: null,
      },
      {
        id: "run_shards",
        kind: "repository",
        name: `acme/web-${suffix}`,
        stage: "ingesting",
        progress: { done: 2, total: 3, unit: "shards" },
      },
      {
        id: "run_waiting",
        kind: "repository",
        name: `acme/web-${suffix}`,
        stage: "waiting",
        progress: null,
      },
      {
        id: "run_hydrate_slow",
        kind: "hydrate",
        name: null,
        stage: null,
        progress: null,
      },
      {
        id: "run_sync",
        kind: "source_sync",
        name: "Linear",
        stage: null,
        progress: null,
      },
    ])
    expect(Date.parse(items[0]?.startedAt ?? "")).toBeLessThan(
      Date.now() - 800_000,
    )
  })

  it("shows a Workspace below format 3 the code index, and an ingestion v2 run only until `resolve` leaves the Workspace out", async () => {
    expect(
      (await readWorkspace("legacy")).map(({ id, stage }) => ({ id, stage })),
    ).toEqual([
      { id: "run_index", stage: "indexing" },
      { id: "run_waiting", stage: "waiting" },
    ])
  })

  it("shows nothing for a Workspace whose only run is a fast hydrate", async () => {
    expect(await readWorkspace("quiet")).toEqual([])
  })

  it("does not count a run older than one day or a hydrate older than three hours", async () => {
    expect(await readWorkspace("stale")).toEqual([])
    expect((await readWorkspace("steady")).map((item) => item.id)).toEqual([
      "run_long",
      "run_hydrate_long",
      "run_corrupt",
    ])
  })

  it("gives a run whose root list does not unzip no progress", async () => {
    const items = await readWorkspace("steady")
    expect(items.find((item) => item.id === "run_corrupt")).toMatchObject({
      kind: "repository",
      stage: "ingesting",
      progress: null,
    })
  })

  it("gives the sidebar only the counts of the Workspaces of the org that have work", async () => {
    const response = await withOrgDbContext(org.id, async () =>
      workspaceHttpApp(org, orgWorkspaceIngestionRoutes).request("/workspaces"),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      workspaces: Array<{
        workspaceSlug: string
        sources: number
        hydrating: boolean
      }>
    }
    // The run of the other org does not count for "busy". The re-ingestion
    // does not count next to its own ingestion v2 run.
    expect(
      body.workspaces.sort((a, b) =>
        a.workspaceSlug.localeCompare(b.workspaceSlug),
      ),
    ).toEqual([
      { workspaceSlug: "busy", sources: 5, hydrating: true },
      { workspaceSlug: "legacy", sources: 2, hydrating: false },
      { workspaceSlug: "steady", sources: 2, hydrating: true },
    ])
  })

  it("shows the other org only its own run", async () => {
    const response = await withOrgDbContext(otherOrg.id, async () =>
      workspaceHttpApp(otherOrg, workspaceIngestionRoutes).request(
        "/workspaces/busy/ingestion",
      ),
    )
    expect(response.status).toBe(200)
    const { items } = (await response.json()) as { items: Item[] }
    expect(items.map((item) => item.id)).toEqual(["run_foreign"])
  })
})
