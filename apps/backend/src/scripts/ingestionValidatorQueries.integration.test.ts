import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq, sql } from "drizzle-orm"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withOrgIdContext } from "../auth/withAuth.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import {
  repositories,
  repositoryIngestionRequests,
} from "../db/schema/repositories.js"
import {
  workspaceKnowledgeUnits,
  workspaces,
  workspaceWriteJobs,
} from "../db/schema/workspaces.js"
import {
  readExtractWriteJob,
  readRepositoryUnits,
  unitKinds,
} from "../models/repository-knowledge-units.js"
import {
  assertExtractionDestination,
  findAttributedIngestions,
  findInFlightIngestion,
  findRunByIdempotencyKey,
  readRepositoryStatus,
  readRunTree,
} from "./ingestionValidatorQueries.js"
import { repositoryUnitKinds } from "./repoGraphSizeCheck.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local"), quiet: true })

const connectionString = process.env.DATABASE_URL
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const org = { id: `org_validator_${suffix}`, slug: `validator-${suffix}` }
const orgId = org.id
const emptyOrgId = `org_validator_empty_${suffix}`
const repositoryId = `repo_validator_${suffix}`
const workspaceId = `ws_validator_${suffix}`
const namespaceId = `validator-test-${suffix}`
const sha = "a".repeat(40)
const traceId = "0af7651916cd43dd8448eb211c80319c"
const worker = "validator-test-worker"

let backend: BackendPostgres
type Json = NonNullable<
  Parameters<BackendPostgres["completeStepAttempt"]>[0]["output"]
>

/** Claim the only pending run of this test namespace. */
async function claim(id: string): Promise<void> {
  const claimed = await backend.claimWorkflowRun({
    workerId: worker,
    leaseDurationMs: 60_000,
  })
  expect(claimed?.id).toBe(id)
}

async function completedStep(
  workflowRunId: string,
  stepName: string,
  output: Json,
): Promise<void> {
  const attempt = await backend.createStepAttempt({
    workflowRunId,
    workerId: worker,
    stepName,
    kind: "function",
    config: {},
    context: null,
  })
  await backend.completeStepAttempt({
    workflowRunId,
    stepAttemptId: attempt.id,
    workerId: worker,
    output,
  })
}

function newRun(
  workflowName: string,
  input: Json,
  extra: {
    idempotencyKey?: string
    parentStepAttemptId?: string
    traceparent?: string
  } = {},
) {
  return backend.createWorkflowRun({
    workflowName,
    version: null,
    idempotencyKey: extra.idempotencyKey ?? null,
    config: {},
    context: extra.traceparent
      ? { traceContext: { traceparent: extra.traceparent } }
      : null,
    input,
    parentStepAttemptNamespaceId: extra.parentStepAttemptId
      ? namespaceId
      : null,
    parentStepAttemptId: extra.parentStepAttemptId ?? null,
    availableAt: null,
    deadlineAt: null,
  })
}

function ingestionInput(requestId: string): Json {
  return { orgId, repositoryId, telemetry: { "request.id": requestId } }
}

describe("ingestion validator queries (Postgres)", () => {
  beforeAll(async () => {
    if (!connectionString) throw new Error("DATABASE_URL is required")
    initDb(connectionString)
    backend = await BackendPostgres.connect(connectionString, {
      namespaceId,
      runMigrations: false,
    })
    await getSystemDb()
      .insert(organizations)
      .values({ ...org, name: "Validator fixture", createdAt: new Date() })
    await withOrgDbContext(orgId, async (db) => {
      await db.insert(repositories).values({
        id: repositoryId,
        orgId,
        name: "validator-fixture",
        gitUrl: `https://github.com/example/validator-${suffix}`,
        indexReady: true,
        indexingStatus: "complete_with_issues",
        indexingError: "scip:go incomplete",
        lastIngestedHash: sha,
      })
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId,
        slug: `validator-${suffix}`,
        displayName: "Validator fixture",
        workspaceRepositoryUrl: `https://github.com/example/workspace-${suffix}`,
        activeProjectionSha: sha,
      })
      await db.insert(workspaceWriteJobs).values([
        {
          id: `wjob_older_${suffix}`,
          orgId,
          workspaceId,
          kind: "extract_ingest",
          generation: 1,
          status: "completed",
          commitSha: "b".repeat(40),
          payload: {
            knowledgePaths: { old: "topics/old.md" },
            extraction: { repositoryId } as never,
          },
          updatedAt: new Date(Date.now() - 60_000),
        },
        {
          id: `wjob_run_${suffix}_extract`,
          orgId,
          workspaceId,
          kind: "extract_ingest",
          generation: 1,
          status: "completed",
          commitSha: sha,
          payload: {
            knowledgePaths: {
              "repo:svc": "services/api.md",
              "repo:doc": "decisions/use-git.md",
              "repo:missing": "topics/missing.md",
            },
            extraction: { repositoryId } as never,
          },
        },
      ])
      await db.insert(workspaceKnowledgeUnits).values([
        {
          servingId: `unit_api_${suffix}`,
          orgId,
          workspaceId,
          path: "services/api.md",
          kind: "Service",
          body: "API",
          projectionSha: sha,
          embedding: [0.1, 0.2],
        },
        {
          servingId: `unit_decision_${suffix}`,
          orgId,
          workspaceId,
          path: "decisions/use-git.md",
          kind: "Decision",
          body: "Use git",
          projectionSha: sha,
        },
        {
          servingId: `unit_other_${suffix}`,
          orgId,
          workspaceId,
          path: "topics/other-repo.md",
          kind: "Topic",
          body: "Another repository's unit",
          projectionSha: sha,
        },
        {
          servingId: `unit_stale_${suffix}`,
          orgId,
          workspaceId,
          path: "topics/missing.md",
          kind: "Topic",
          body: "From an older projection",
          projectionSha: "d".repeat(40),
        },
      ])
    })
  })

  afterAll(async () => {
    await withOrgDbContext(orgId, async (db) => {
      await db
        .delete(repositoryIngestionRequests)
        .where(eq(repositoryIngestionRequests.repositoryId, repositoryId))
      await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
      await db.delete(repositories).where(eq(repositories.id, repositoryId))
    })
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where namespace_id = ${namespaceId}`,
    )
    await backend.stop()
    await closeDb()
  })

  it("reads the native run tree with roots, request ids, trace ids, trimmed outputs, and the hydrate run by key", async () => {
    const orchestrator = await newRun(
      "repository-ingestion-orchestrator",
      ingestionInput("val_tree"),
      { traceparent: `00-${traceId}-b7ad6b7169203331-01` },
    )
    await claim(orchestrator.id)
    const childStep = await backend.createStepAttempt({
      workflowRunId: orchestrator.id,
      workerId: worker,
      stepName: "repository-ingestion-child",
      kind: "workflow",
      config: {},
      context: null,
    })
    const ingestion = await newRun(
      "repository-ingestion",
      ingestionInput("val_tree"),
      { parentStepAttemptId: childStep.id },
    )
    await backend.setStepAttemptChildWorkflowRun({
      workflowRunId: orchestrator.id,
      stepAttemptId: childStep.id,
      workerId: worker,
      childWorkflowRunNamespaceId: namespaceId,
      childWorkflowRunId: ingestion.id,
    })
    await claim(ingestion.id)
    await completedStep(ingestion.id, "detect-languages:admit-1", {
      admitted: true,
      value: { detectedLanguages: ["go"], languagesToIndex: ["go"] },
    })
    await completedStep(ingestion.id, "identify-roots", {
      roots: ["a large extraction payload the validator never reads"],
    })
    await backend.completeWorkflowRun({
      workflowRunId: ingestion.id,
      workerId: worker,
      output: { targetHash: sha, changedPaths: ["every", "file"] },
    })
    const hydrate = await newRun(
      "workspace-hydrate",
      { orgId, workspaceId, revision: { sha } },
      { idempotencyKey: `wjob_${ingestion.id}_extract:hydrate` },
    )

    expect(
      await findRunByIdempotencyKey({
        orgId,
        namespaceId,
        workflowName: "workspace-hydrate",
        idempotencyKey: `wjob_${ingestion.id}_extract:hydrate`,
      }),
    ).toBe(hydrate.id)

    const tree = await readRunTree({
      orgId,
      namespaceId,
      rootRunIds: [orchestrator.id, hydrate.id],
    })
    expect(
      tree.runs
        .map((run) => [run.workflowName, run.status, run.rootRunId])
        .sort(),
    ).toEqual([
      ["repository-ingestion", "completed", orchestrator.id],
      ["repository-ingestion-orchestrator", "running", orchestrator.id],
      ["workspace-hydrate", "pending", hydrate.id],
    ])
    const byName = (name: string) =>
      tree.runs.find((run) => run.workflowName === name)
    expect(byName("repository-ingestion-orchestrator")).toMatchObject({
      traceId,
      requestId: "val_tree",
    })
    expect(byName("repository-ingestion")).toMatchObject({
      parentRunId: orchestrator.id,
      parentStepName: "repository-ingestion-child",
      output: { targetHash: sha },
    })
    expect(byName("repository-ingestion")?.output).not.toHaveProperty(
      "changedPaths",
    )
    expect(byName("workspace-hydrate")).toMatchObject({
      revisionSha: sha,
      workspaceId,
    })
    const step = (name: string) =>
      tree.steps.find((attempt) => attempt.stepName === name)
    expect(step("detect-languages:admit-1")?.output).toEqual({
      admitted: true,
      value: { detectedLanguages: ["go"], languagesToIndex: ["go"] },
    })
    expect(step("identify-roots")).toMatchObject({
      status: "completed",
      output: null,
    })
    expect(step("repository-ingestion-child")?.childRunId).toBe(ingestion.id)
  })

  it("finds the validator's own ingestion and its follow-ups, and an in-flight owner", async () => {
    const own = await newRun(
      "repository-ingestion-orchestrator",
      ingestionInput("val_follow"),
    )
    await newRun("repository-ingestion-orchestrator", ingestionInput("other"))
    const followUp = await newRun(
      "repository-ingestion-orchestrator",
      ingestionInput("val_follow"),
    )
    // Runs created in one burst can share created_at; the order is not part
    // of the contract.
    const attributed = await findAttributedIngestions({
      orgId,
      namespaceId,
      repositoryId,
      requestId: "val_follow",
    })
    expect([...attributed].sort()).toEqual([own.id, followUp.id].sort())

    const repository = await withOrgDbContext(orgId, async (db) => {
      const [row] = await db
        .select()
        .from(repositories)
        .where(eq(repositories.id, repositoryId))
      return row
    })
    await withOrgDbContext(orgId, (db) =>
      db.insert(repositoryIngestionRequests).values({
        repositoryId,
        orgId,
        requestId: `request_${suffix}`,
        repositoryUrl: repository?.gitUrl ?? "",
        githubConnectionId: null,
        targetBranch: null,
        indexingReason: null,
        workflowRunId: followUp.id,
        createdAt: new Date(),
      }),
    )
    expect(
      await findInFlightIngestion({ orgId, namespaceId, repositoryId }),
    ).toEqual({ id: followUp.id, requestId: "val_follow" })
    await backend.cancelWorkflowRun({ workflowRunId: followUp.id })
    expect(
      await findInFlightIngestion({ orgId, namespaceId, repositoryId }),
    ).toBeNull()
  })

  it("allows extraction only into the org's sole validation Workspace", async () => {
    await expect(
      assertExtractionDestination({
        orgId: emptyOrgId,
        mode: "index-only",
        workspaceId: null,
      }),
    ).resolves.toBeUndefined()
    await expect(
      assertExtractionDestination({
        orgId,
        mode: "index-only",
        workspaceId: null,
      }),
    ).rejects.toThrow(/index-only refuses an org with a Workspace/)
    await expect(
      assertExtractionDestination({ orgId, mode: "full", workspaceId }),
    ).resolves.toBeUndefined()
    await expect(
      assertExtractionDestination({
        orgId,
        mode: "full",
        workspaceId: "ws_elsewhere",
      }),
    ).rejects.toThrow(/only Workspace/)

    await withOrgDbContext(orgId, (db) =>
      db.insert(workspaces).values({
        id: `${workspaceId}_second`,
        orgId,
        slug: `validator-second-${suffix}`,
        displayName: "Second",
        workspaceRepositoryUrl: `https://github.com/example/second-${suffix}`,
      }),
    )
    await expect(
      assertExtractionDestination({ orgId, mode: "full", workspaceId }),
    ).rejects.toThrow(/found 2/)
    await withOrgDbContext(orgId, (db) =>
      db.delete(workspaces).where(eq(workspaces.id, `${workspaceId}_second`)),
    )
  })

  it("reads the repository row, the extraction job, and its units at the published projection", async () => {
    expect(await readRepositoryStatus(orgId, repositoryId)).toEqual({
      indexingStatus: "complete_with_issues",
      indexingError: "scip:go incomplete",
      lastIngestedHash: sha,
      indexReady: true,
    })
    const job = await readExtractWriteJob(orgId, {
      jobId: `wjob_run_${suffix}_extract`,
    })
    expect(job).toMatchObject({ status: "completed", commitSha: sha })
    const read = await withOrgIdContext(org, () =>
      readRepositoryUnits(
        workspaceId,
        Object.values(job?.knowledgePaths ?? {}),
      ),
    )
    expect(read.projectionSha).toBe(sha)
    expect(read.units.map((unit) => unit.path).sort()).toEqual([
      "decisions/use-git.md",
      "services/api.md",
    ])
    expect(read.workspaceUnits).toHaveLength(3)
    expect(unitKinds(read.units)).toEqual({ Service: 1, Decision: 1 })
    expect(read.units.filter((unit) => !unit.embedding)).toHaveLength(1)
    expect(
      await readExtractWriteJob(`org_other_${suffix}`, {
        jobId: job?.id ?? "",
      }),
    ).toBeNull()
  })

  it("sizes a repository from its latest completed extraction", async () => {
    expect(
      await repositoryUnitKinds({ orgId, workspaceId, repositoryId }),
    ).toEqual({ Service: 1, Decision: 1 })
  })
})
