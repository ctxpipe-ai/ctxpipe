import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { and, eq, sql } from "drizzle-orm"
import { OpenWorkflow } from "openworkflow"

import { withOrgIdContext } from "../../src/auth/withAuth.js"
import { parseEnv } from "../../src/config/env.js"
import { getSystemDb, withOrgDbContext } from "../../src/db/client.js"
import { organizations } from "../../src/db/schema/auth.js"
import { orgFeatures } from "../../src/db/schema/org_features.js"
import { workspaces } from "../../src/db/schema/workspaces.js"
import { resolveWorkspaceReadRevision } from "../../src/domain/workspaces/resolve-revision.js"
import {
  getKnowledgeState,
  readyKnowledgeHeads,
} from "../../src/models/knowledge-state.js"
import { getWorkspaceProjection } from "../../src/models/workspaces.js"
import { openWorkflowNamespaceId } from "../../src/openworkflow/namespace.js"
import { connectOpenWorkflowBackend } from "../../src/openworkflow/storable-backend.js"
import { knowledgeProjection } from "../../src/openworkflow/workflows/knowledge-projection.js"
import { workspaceHydrate } from "../../src/openworkflow/workflows/workspace-hydrate.js"
import type { Corpus, Dataset } from "./dataset.js"
import { EVAL_NAMESPACE } from "./eval-namespace.js"
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
 * Each corpus gets one Workspace in the eval org, at the frozen SHA and the
 * root of the corpus, with the org flag `knowledge_plane` at `shadow`. A
 * second hydrate of the same SHA finds both stacks current.
 */

/** An org of the evals. Its ids are made up: the run folder holds them. */
export type EvalOrg = { id: string; slug: string; name: string }

/** The longest wait for the hydrate of one corpus, in ms. */
const HYDRATE_TIMEOUT_MS = 60 * 60_000

/**
 * Hydrate each corpus of `dataset` into both stacks in the org `org`. It
 * returns the targets of `run`, and the count of `failed` documents of the
 * plane for each corpus: a file that does not parse, a file type with no
 * converter, or a failed vision call (ADR-067 decision 8). The model calls
 * go through `calls`, which `install` put in front of `fetch`: the spend cap
 * applies to them. Throws when a step of a workflow fails, or when a stack
 * does not serve the frozen SHA after the hydrate.
 */
export async function hydrateCorpora(input: {
  dataset: Dataset
  org: EvalOrg
  databaseUrl: string
  calls: ModelCalls
  log: (line: string) => void
}): Promise<{ targets: Targets; failedDocuments: Record<string, number> }> {
  const { calls, log, org } = input
  // The worker takes each run of its namespace, and the hydrate queues the
  // projection through the OpenWorkflow client, which read the namespace
  // when it loaded (`eval-namespace.ts`).
  const namespace = openWorkflowNamespaceId()
  if (!namespace.startsWith(EVAL_NAMESPACE))
    throw new Error(
      `The hydrate runs only in an OpenWorkflow namespace of its own (${EVAL_NAMESPACE}…), not in "${namespace}".`,
    )
  for (const corpus of input.dataset.corpora)
    if (!["http:", "https:"].includes(new URL(corpus.contextRepo.url).protocol))
      throw new Error(
        `The context repo of ${corpus.id} must have an http or https URL.`,
      )
  await getSystemDb()
    .insert(organizations)
    .values({ ...org, createdAt: new Date() })
    .onConflictDoNothing()
  await withOrgDbContext(org.id, (db) =>
    db
      .insert(orgFeatures)
      .values({
        organizationId: org.id,
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
  const restoreGit = isolateGit()
  await worker.start()
  const targets: Targets = {}
  const failedDocuments: Record<string, number> = {}
  try {
    for (const corpus of input.dataset.corpora) {
      calls.begin("hydrate", corpus.id)
      const started = performance.now()
      // The clock of the database writes the time of each run.
      const [now] = (await getSystemDb().execute(sql`select now() as now`))
        .rows as { now: string | Date }[]
      const since = new Date(now?.now ?? Date.now())
      const workspaceId = await upsertWorkspace(org, corpus)
      const revision = await withOrgIdContext(org, () =>
        resolveWorkspaceReadRevision({
          orgId: org.id,
          workspaceId,
          env: parseEnv(process.env),
        }),
      )
      if (!revision)
        throw new Error(`The Workspace of ${corpus.id} has no revision.`)
      await runner.runWorkflow(workspaceHydrate.spec, {
        orgId: org.id,
        workspaceId,
        revision: revision.revision,
      })
      await waitForBothStacks({
        org,
        namespace,
        workspaceId,
        sha: corpus.contextRepo.sha,
        since,
      })
      await calls.settle()
      const counts = calls.end()
      const failed =
        (await getKnowledgeState({ orgId: org.id, workspaceId }))
          ?.failedCount ?? 0
      failedDocuments[corpus.id] = failed
      log(
        `${corpus.id}: both stacks serve ${corpus.contextRepo.sha} after ${Math.round((performance.now() - started) / 1000)} s; ${counts.embedding} embedding calls, $${counts.costUsd.toFixed(4)}; ${failed} failed documents on the plane.`,
      )
      targets[corpus.workspace] = {
        orgId: org.id,
        orgSlug: org.slug,
        workspace: corpus.workspace,
      }
    }
  } finally {
    await worker.stop()
    // The hydrate also queues jobs that the eval does not run: the code
    // index of the Workspace, and the maintenance job of the plane, which
    // can write to the context repo. The corpus is frozen, so remove them,
    // and the runs that a failed hydrate left.
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs
        where namespace_id = ${namespace}
          and input->>'orgId' = ${org.id}
          and status not in ('completed', 'failed')`,
    )
    await backend.stop()
    restoreGit()
  }
  return { targets, failedDocuments }
}

/**
 * Make each Git process of the hydrate read with no credential of the host:
 * no global or system configuration (and thus no credential helper), no
 * configuration from the environment, no prompt, and an empty home folder
 * (no `.netrc`). The corpora are public, and a dataset must not make the
 * hydrate read a private repository with the credentials of the operator.
 * Call the result to restore the environment.
 */
function isolateGit(): () => void {
  const home = mkdtempSync(join(tmpdir(), "knowledge-eval-git-home-"))
  const names = [
    "HOME",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_TERMINAL_PROMPT",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
  ] as const
  const before = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  )
  for (const name of names) delete process.env[name]
  Object.assign(process.env, {
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  })
  return () => {
    for (const name of names) {
      const value = before[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
}

/**
 * The Workspace of `corpus` at its frozen SHA and root. A Workspace that
 * wants another SHA, URL or root gets the new values and the next
 * generation, so that both stacks project it again. Returns its id.
 */
async function upsertWorkspace(org: EvalOrg, corpus: Corpus): Promise<string> {
  const id = `${org.id.replace(/^org_/, "ws_")}_${corpus.id}`
  const { url, sha, root } = corpus.contextRepo
  const where = and(eq(workspaces.orgId, org.id), eq(workspaces.id, id))
  return withOrgDbContext(org.id, async (db) => {
    const [existing] = await db.select().from(workspaces).where(where)
    if (!existing) {
      await db.insert(workspaces).values({
        id,
        orgId: org.id,
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
          updatedAt: new Date(),
        })
        .where(where)
    return id
  })
}

/**
 * Wait until both stacks serve `sha` for the Workspace:
 * - each hydrate and projection run of the Workspace since `since` is
 *   complete;
 * - the old stack publishes `sha` with ready embeddings and a ready graph
 *   (the hydrate records a failure of these stores and still completes);
 * - the plane serves `sha`.
 *
 * A failed step of such a run, or a failed store, stops the wait with its
 * error: the workflows retry an outage for minutes, but in an eval a failure
 * is almost always a setup error. A second hydrate continues from the
 * stored state.
 */
async function waitForBothStacks(input: {
  org: EvalOrg
  namespace: string
  workspaceId: string
  sha: string
  since: Date
}): Promise<void> {
  const { org, workspaceId, sha } = input
  const runs = sql`run.namespace_id = ${input.namespace}
    and run.workflow_name in (${workspaceHydrate.spec.name}, ${knowledgeProjection.spec.name})
    and run.input->>'workspaceId' = ${workspaceId}
    and run.created_at >= ${input.since.toISOString()}`
  const deadline = Date.now() + HYDRATE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const failed = await getSystemDb().execute(
      sql`select step.step_name, step.error->>'message' as message
        from openworkflow.step_attempts step
        join openworkflow.workflow_runs run
          on run.namespace_id = step.namespace_id
          and run.id = step.workflow_run_id
        where ${runs} and step.status = 'failed'
        limit 1`,
    )
    const [step] = failed.rows as { step_name: string; message: string }[]
    if (step)
      throw new Error(
        `The step ${step.step_name} of the hydrate of ${workspaceId} failed: ${step.message}`,
      )
    const open = await getSystemDb().execute(
      sql`select 1 from openworkflow.workflow_runs run
        where ${runs} and run.status not in ('completed', 'failed')`,
    )
    if (open.rows.length === 0) {
      const old = await withOrgIdContext(org, () =>
        getWorkspaceProjection(workspaceId),
      )
      if (old.kind !== "active" || old.revision.sha !== sha)
        throw new Error(
          `The old stack does not publish ${sha} for ${workspaceId} after the hydrate.`,
        )
      for (const [store, result] of Object.entries({
        embeddings: old.stores.embeddings,
        graph: old.stores.graph,
      }))
        if (result.kind !== "ready")
          throw new Error(
            `The old stack has the state ${result.kind} for its ${store} of ${workspaceId}${result.kind === "failed" ? `: ${result.message}` : ""}.`,
          )
      const plane = (await readyKnowledgeHeads(org.id, [workspaceId])).get(
        workspaceId,
      )?.sha
      if (plane !== sha)
        throw new Error(
          `The plane serves ${plane ?? "nothing"} for ${workspaceId} after the hydrate, not ${sha}.`,
        )
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(
    `The hydrate of ${workspaceId} did not end in ${HYDRATE_TIMEOUT_MS / 60_000} minutes.`,
  )
}
