import { eq, sql } from "drizzle-orm"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { connections } from "../../db/schema/connections.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import {
  ingestionRunStates,
  orgHasRecentIngestionRun,
} from "../../models/ingestion-runs.js"
import { unfinishedOrgWorkflowRunIds } from "../../models/workspace-sandboxes.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import {
  IngestRefRefusedError,
  ingestRefName,
} from "../ingestion/ingest-refs.js"
import {
  INGESTION_V2_WORKFLOW_NAME,
  type IngestionV2RunInput,
} from "../ingestion/ingestion-run.js"
import {
  findWorkspaceStepCommit,
  pushWorkspaceIngestStep,
} from "./write-broker.js"

const DAY = 24 * 60 * 60 * 1000

function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for ingest ref jobs")
  return url
}

let backend: BackendPostgres

beforeAll(async () => {
  initDb(databaseUrl())
  backend = await BackendPostgres.connect(databaseUrl(), {
    runMigrations: false,
    namespaceId: openWorkflowNamespaceId(),
  })
})

afterAll(async () => {
  await backend.stop()
  await closeDb()
})

type Org = { orgId: string; workspaceId: string }

/** Real rows: an org, a GitHub connection, and a bound Workspace. */
async function withOrg<T>(
  fn: (org: Org) => Promise<T>,
  workspace: { writeStatus?: string } = {},
): Promise<T> {
  const orgId = generateObjectId("org")
  const workspaceId = generateObjectId("ws")
  const connectionId = generateObjectId("con")
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Ingest ref proof",
    createdAt: new Date(),
  })
  await withOrgDbContext(orgId, async (db) => {
    await db
      .insert(connections)
      .values({ id: connectionId, orgId, type: "github", config: {} })
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      slug: "context",
      displayName: "Context",
      workspaceRepositoryUrl: "https://github.com/example-org/context.git",
      githubConnectionId: connectionId,
      desiredGeneration: 4,
      desiredSha: "a".repeat(40),
      desiredDefaultBranch: "main",
      writeStatus: workspace.writeStatus ?? "writable",
    })
  })
  try {
    return await withOrgIdContext({ id: orgId, slug: orgId }, () =>
      fn({ orgId, workspaceId }),
    )
  } finally {
    await withOrgDbContext(orgId, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
      await db.delete(connections).where(eq(connections.orgId, orgId))
    })
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  }
}

async function createRun(
  orgId: string,
  options: {
    version?: string | null
    workflowName?: string
    finishedAt?: Date
    shadow?: boolean
  } = {},
): Promise<string> {
  const run = await backend.createWorkflowRun({
    workflowName: options.workflowName ?? INGESTION_V2_WORKFLOW_NAME,
    version: options.version ?? null,
    idempotencyKey: null,
    config: {},
    context: null,
    input: {
      orgId,
      shadow: options.shadow ?? true,
    } satisfies IngestionV2RunInput,
    parentStepAttemptNamespaceId: null,
    parentStepAttemptId: null,
    // Never due: no worker claims it.
    availableAt: new Date(Date.now() + 365 * DAY),
    deadlineAt: null,
  })
  if (options.finishedAt) {
    await backend.cancelWorkflowRun({ workflowRunId: run.id })
    await getSystemDb().execute(
      sql`update openworkflow.workflow_runs set finished_at = ${options.finishedAt.toISOString()}::timestamptz, created_at = ${options.finishedAt.toISOString()}::timestamptz where id = ${run.id}`,
    )
  }
  return run.id
}

describe("ingestion run states", () => {
  it("reads unfinished, finished, versioned, and shadow runs of the org only", async () => {
    await withOrg(async ({ orgId }) => {
      const other = generateObjectId("org")
      const live = await createRun(orgId)
      const versioned = await createRun(orgId, { version: "2" })
      const finishedAt = new Date(Date.now() - 2 * DAY)
      const done = await createRun(orgId, { finishedAt, shadow: false })
      const foreign = await createRun(other)
      const otherWorkflow = await createRun(orgId, {
        workflowName: "repository-ingestion-orchestrator",
      })
      const states = await ingestionRunStates(orgId, [
        live,
        versioned,
        done,
        foreign,
        otherWorkflow,
        "run_unknown",
      ])
      expect(Object.fromEntries(states)).toEqual({
        [live]: { unfinished: true, finishedAt: null, shadow: true },
        [versioned]: { unfinished: true, finishedAt: null, shadow: true },
        [done]: { unfinished: false, finishedAt, shadow: false },
      })
      // The sandbox sweep counts a versioned run as unfinished too.
      await expect(
        unfinishedOrgWorkflowRunIds(orgId, INGESTION_V2_WORKFLOW_NAME, [
          live,
          versioned,
          done,
        ]),
      ).resolves.toEqual(new Set([live, versioned]))
      for (const id of [live, versioned, foreign, otherWorkflow])
        await backend.cancelWorkflowRun({ workflowRunId: id })
    })
  })

  it("finds an org with an ingestion run in the last 7 days", async () => {
    await withOrg(async ({ orgId }) => {
      const since = new Date(Date.now() - 7 * DAY)
      await expect(orgHasRecentIngestionRun(orgId, since)).resolves.toBe(false)
      await createRun(orgId, { finishedAt: new Date(Date.now() - 8 * DAY) })
      await expect(orgHasRecentIngestionRun(orgId, since)).resolves.toBe(false)
      await createRun(orgId, { finishedAt: new Date(Date.now() - 6 * DAY) })
      await expect(orgHasRecentIngestionRun(orgId, since)).resolves.toBe(true)
    })
  })
})

describe("ingest ref broker jobs", () => {
  const env = parseEnv(process.env as Record<string, string | undefined>)

  function stepJob(org: Org, runId: string, generation = 4) {
    return {
      orgId: org.orgId,
      job: { runId, workspaceId: org.workspaceId, generation },
      ref: ingestRefName({ runId, workspaceId: org.workspaceId, shard: "0" }),
      oldTip: null,
      pinnedRevision: "a".repeat(40),
      baseCommit: "a".repeat(40),
      commit: { step: "s", bundle: "b", authorTime: new Date(0) },
      patch: {
        stagedDir: "/nonexistent",
        source: {
          url: "https://github.com/example-org/api",
          sha: "b".repeat(40),
        },
        sourcePath: "sources/github/example-org/api.md",
        skill: "apis",
        sourcePathExists: async () => true,
        readSourceFile: async () => null,
      },
    }
  }

  it("refuses a run that is unknown, finished, or of another org", async () => {
    await withOrg(async (org) => {
      const finished = await createRun(org.orgId, { finishedAt: new Date() })
      const foreign = await createRun(generateObjectId("org"))
      for (const runId of ["run_unknown", finished, foreign]) {
        await expect(
          pushWorkspaceIngestStep(stepJob(org, runId), env),
        ).rejects.toBeInstanceOf(IngestRefRefusedError)
        await expect(
          findWorkspaceStepCommit(
            {
              orgId: org.orgId,
              job: { runId, workspaceId: org.workspaceId, generation: 4 },
              ref: ingestRefName({ runId, workspaceId: org.workspaceId }),
              step: "s",
            },
            env,
          ),
        ).rejects.toBeInstanceOf(IngestRefRefusedError)
      }
      await backend.cancelWorkflowRun({ workflowRunId: foreign })
    })
  })

  it("refuses a Workspace that is not writable", async () => {
    await withOrg(
      async (org) => {
        const runId = await createRun(org.orgId)
        await expect(
          pushWorkspaceIngestStep(stepJob(org, runId), env),
        ).rejects.toBeInstanceOf(IngestRefRefusedError)
        await backend.cancelWorkflowRun({ workflowRunId: runId })
      },
      { writeStatus: "read_only" },
    )
  })

  it("refuses a job of an older Workspace binding", async () => {
    await withOrg(async (org) => {
      const runId = await createRun(org.orgId)
      await expect(
        pushWorkspaceIngestStep(stepJob(org, runId, 3), env),
      ).rejects.toBeInstanceOf(IngestRefRefusedError)
      // The current binding passes the checks and goes on to the credential.
      await expect(
        pushWorkspaceIngestStep(stepJob(org, runId), env),
      ).rejects.not.toBeInstanceOf(IngestRefRefusedError)
      await backend.cancelWorkflowRun({ workflowRunId: runId })
    })
  })
})
