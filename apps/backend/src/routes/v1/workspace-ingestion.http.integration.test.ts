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
import { workspaces } from "../../db/schema/workspaces.js"
import { packRoots } from "../../domain/ingestion/ingestion-plan.js"
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
  ageSeconds: number
  input: Record<string, unknown>
}) {
  await getSystemDb().execute(sql`
    insert into openworkflow.workflow_runs
      (namespace_id, id, workflow_name, status, config, input, attempts,
       available_at, created_at, updated_at)
    values
      (${namespace}, ${input.id}, ${input.name}, ${input.status ?? "running"},
       '{}'::jsonb, ${JSON.stringify(input.input)}::jsonb, 1, now(),
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
  const response = await withOrgDbContext(org.id, () =>
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
        [busy, quiet].map((id) => ({
          id,
          orgId: org.id,
          slug: id === busy ? "busy" : "quiet",
          displayName: id,
          workspaceRepositoryUrl: `https://github.com/example/${id}.git`,
          formatVersion: 3,
        })),
      )
      await insertProjectedSourceRows(db, [
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
    await insertStep("run_shards", "resolve", "completed", {})
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
      ageSeconds: 2,
      input: { orgId: org.id, workspaceId: quiet },
    })
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
    await withOrgDbContext(org.id, (db) =>
      db.delete(workspaces).where(eq(workspaces.orgId, org.id)),
    )
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
        stage: "reingesting",
        progress: { done: 1, total: 2, unit: "repositories" },
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
        name: "Newest commit",
        stage: "hydrating",
        progress: null,
      },
      {
        id: "run_sync",
        kind: "source_sync",
        name: "Linear",
        stage: "syncing",
        progress: null,
      },
    ])
    expect(Date.parse(items[0]?.startedAt ?? "")).toBeLessThan(
      Date.now() - 800_000,
    )
  })

  it("shows nothing for a Workspace whose only run is a fast hydrate", async () => {
    expect(await readWorkspace("quiet")).toEqual([])
  })

  it("gives the sidebar only the Workspaces of the org that have work", async () => {
    const response = await withOrgDbContext(org.id, () =>
      workspaceHttpApp(org, orgWorkspaceIngestionRoutes).request("/workspaces"),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      workspaces: Array<{ workspaceSlug: string; items: Item[] }>
    }
    expect(body.workspaces.map((w) => w.workspaceSlug)).toEqual(["busy"])
    expect(body.workspaces[0]?.items.map((item) => item.id)).not.toContain(
      "run_foreign",
    )
  })

  it("shows the other org only its own run", async () => {
    const response = await withOrgDbContext(otherOrg.id, () =>
      workspaceHttpApp(otherOrg, workspaceIngestionRoutes).request(
        "/workspaces/busy/ingestion",
      ),
    )
    expect(response.status).toBe(200)
    const { items } = (await response.json()) as { items: Item[] }
    expect(items.map((item) => item.id)).toEqual(["run_foreign"])
  })
})
