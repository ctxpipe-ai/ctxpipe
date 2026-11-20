import { and, eq, sql } from "drizzle-orm"
import { OpenWorkflow } from "openworkflow"

import { withOrgIdContext } from "../../src/auth/withAuth.js"
import { parseEnv } from "../../src/config/env.js"
import { getSystemDb, withOrgDbContext } from "../../src/db/client.js"
import { organizations } from "../../src/db/schema/auth.js"
import { orgFeatures } from "../../src/db/schema/org_features.js"
import { workspaces } from "../../src/db/schema/workspaces.js"
import { resolveWorkspaceReadRevision } from "../../src/domain/workspaces/resolve-revision.js"
import { readyKnowledgeShas } from "../../src/models/knowledge-state.js"
import { connectOpenWorkflowBackend } from "../../src/openworkflow/storable-backend.js"
import { knowledgeProjection } from "../../src/openworkflow/workflows/knowledge-projection.js"
import { workspaceHydrate } from "../../src/openworkflow/workflows/workspace-hydrate.js"
import type { Corpus, Dataset } from "./dataset.js"
import type { ModelCalls } from "./model-calls.js"
import type { Targets } from "./runner.js"

/*
 * The hydrate of an eval run (ADR-069 decision 3): each corpus of the
 * dataset goes into both stacks of the database of the run, through the
 * real workflows. `workspace-hydrate` writes the old stack (Postgres and
 * FalkorDB), and it queues `knowledge-projection`, which writes the plane
 * (ClickHouse). The ingest output is the frozen context repo, so the
 * hydrate makes no ingest call: only the embedding calls (and a vision call
 * for each image) of the two writers.
 *
 * Each corpus gets one Workspace in one eval org, at the frozen SHA and the
 * root of the corpus, with the org flag `knowledge_plane` at `shadow`. A
 * second hydrate of the same SHA finds both stacks current.
 */

/** The eval org. Its ids are made up: the run folder holds them. */
const EVAL_ORG = {
  id: "org_knowledge_eval",
  slug: "knowledge-eval",
  name: "Knowledge eval",
}

/** The longest wait for the hydrate of one corpus, in ms. */
const HYDRATE_TIMEOUT_MS = 60 * 60_000

/** The Workspace of a corpus: its id is fixed, so a second hydrate finds it. */
const workspaceIdOf = (corpus: Corpus) => `ws_knowledge_eval_${corpus.id}`

/**
 * Hydrate each corpus of `dataset` into both stacks, and return the targets
 * of `run`. The model calls go through `calls`, which `install` put in
 * front of `fetch`: the spend cap applies to them. Throws when a workflow
 * fails, or when a stack does not serve the frozen SHA after it.
 */
export async function hydrateCorpora(input: {
  dataset: Dataset
  databaseUrl: string
  calls: ModelCalls
  log: (line: string) => void
}): Promise<Targets> {
  const { calls, log } = input
  await getSystemDb()
    .insert(organizations)
    .values({ ...EVAL_ORG, createdAt: new Date() })
    .onConflictDoNothing()
  await withOrgDbContext(EVAL_ORG.id, (db) =>
    db
      .insert(orgFeatures)
      .values({
        organizationId: EVAL_ORG.id,
        feature: "knowledge_plane",
        value: "shadow",
      })
      .onConflictDoUpdate({
        target: [orgFeatures.organizationId, orgFeatures.feature],
        set: { value: "shadow", updatedAt: new Date() },
      }),
  )
  const backend = await connectOpenWorkflowBackend(input.databaseUrl)
  const runner = new OpenWorkflow({ backend })
  runner.implementWorkflow(workspaceHydrate.spec, workspaceHydrate.fn)
  runner.implementWorkflow(knowledgeProjection.spec, knowledgeProjection.fn)
  const worker = runner.newWorker({ concurrency: 2 })
  await worker.start()
  const targets: Targets = {}
  try {
    for (const corpus of input.dataset.corpora) {
      calls.begin("hydrate", corpus.id)
      const started = performance.now()
      const since = new Date()
      const workspaceId = await upsertWorkspace(corpus)
      const revision = await withOrgIdContext(EVAL_ORG, () =>
        resolveWorkspaceReadRevision({
          orgId: EVAL_ORG.id,
          workspaceId,
          env: parseEnv(process.env),
        }),
      )
      if (!revision)
        throw new Error(`The Workspace of ${corpus.id} has no revision.`)
      const handle = await runner.runWorkflow(workspaceHydrate.spec, {
        orgId: EVAL_ORG.id,
        workspaceId,
        revision: revision.revision,
      })
      await waitForBothStacks({
        runId: handle.workflowRun.id,
        workspaceId,
        sha: corpus.contextRepo.sha,
        since,
      })
      await calls.settle()
      const counts = calls.end()
      log(
        `${corpus.id}: both stacks serve ${corpus.contextRepo.sha} after ${Math.round((performance.now() - started) / 1000)} s; ${counts.embedding} embedding calls, $${counts.costUsd.toFixed(4)}.`,
      )
      targets[corpus.workspace] = {
        orgId: EVAL_ORG.id,
        orgSlug: EVAL_ORG.slug,
        workspace: corpus.workspace,
      }
    }
  } finally {
    await worker.stop()
    // The hydrate also queues jobs that the eval does not run: the code
    // index of the Workspace, and the maintenance job of the plane, which
    // can write to the context repo. The corpus is frozen, so remove them.
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs
        where status = 'pending'
          and (input->>'orgId' = ${EVAL_ORG.id}
            or input->'revision'->>'workspaceId' like 'ws_knowledge_eval_%')`,
    )
    await backend.stop()
  }
  return targets
}

/**
 * The Workspace of `corpus` at its frozen SHA and root. A Workspace that
 * wants another SHA, URL or root gets the new values and the next
 * generation. Returns its id.
 */
async function upsertWorkspace(corpus: Corpus): Promise<string> {
  const id = workspaceIdOf(corpus)
  const { url, sha, root } = corpus.contextRepo
  return withOrgDbContext(EVAL_ORG.id, async (db) => {
    const [existing] = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.orgId, EVAL_ORG.id), eq(workspaces.id, id)))
    if (!existing) {
      await db.insert(workspaces).values({
        id,
        orgId: EVAL_ORG.id,
        slug: corpus.workspace,
        displayName: corpus.source,
        workspaceRepositoryUrl: url,
        rootPath: root,
        desiredSha: sha,
        desiredGeneration: 1,
        desiredDefaultBranch: "main",
        // The code index of the Workspace is not part of the eval, and a
        // lagging index holds back the hydrate.
        indexedSha: sha,
      })
      return id
    }
    if (
      existing.workspaceRepositoryUrl !== url ||
      existing.rootPath !== root ||
      existing.desiredSha !== sha
    )
      await db
        .update(workspaces)
        .set({
          workspaceRepositoryUrl: url,
          rootPath: root,
          desiredSha: sha,
          indexedSha: sha,
          desiredGeneration: existing.desiredGeneration + 1,
        })
        .where(eq(workspaces.id, id))
    return id
  })
}

/**
 * Wait until both stacks serve `sha` for the Workspace: the hydrate run
 * `runId` is complete, and so is the projection that it queued. A failed
 * step of a run of the Workspace since `since` stops the wait with its
 * error: the workflows retry an outage for minutes, but in an eval a failed
 * step is almost always a setup error. A second hydrate continues from the
 * stored state.
 */
async function waitForBothStacks(input: {
  runId: string
  workspaceId: string
  sha: string
  since: Date
}): Promise<void> {
  const deadline = Date.now() + HYDRATE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const failed = await getSystemDb().execute(
      sql`select step.step_name, step.error->>'message' as message
        from openworkflow.step_attempts step
        join openworkflow.workflow_runs run
          on run.namespace_id = step.namespace_id
          and run.id = step.workflow_run_id
        where run.input->>'workspaceId' = ${input.workspaceId}
          and run.created_at >= ${input.since.toISOString()}
          and step.status = 'failed'
        limit 1`,
    )
    const [step] = failed.rows as { step_name: string; message: string }[]
    if (step)
      throw new Error(
        `The step ${step.step_name} of the hydrate of ${input.workspaceId} failed: ${step.message}`,
      )
    const hydrated = await getSystemDb().execute(
      sql`select 1 from openworkflow.workflow_runs
        where id = ${input.runId} and status = 'completed'`,
    )
    const plane = (
      await readyKnowledgeShas(EVAL_ORG.id, [input.workspaceId])
    ).get(input.workspaceId)
    if (hydrated.rows.length > 0 && plane === input.sha) return
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(
    `Both stacks do not serve ${input.sha} for ${input.workspaceId} after ${HYDRATE_TIMEOUT_MS / 60_000} minutes.`,
  )
}
