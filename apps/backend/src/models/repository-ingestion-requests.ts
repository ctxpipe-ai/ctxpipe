import { randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { type Db, withOrgDbContext } from "../db/client.js"
import {
  repositories,
  repositoryIngestionRequests,
} from "../db/schema/repositories.js"

type Request = typeof repositoryIngestionRequests.$inferSelect
export type RepositoryIngestionIntent = {
  orgId: string
  repositoryId: string
  targetBranch?: string | null
  indexingReason?: string | null
}
type Owner = { id: string; status: string; input: Record<string, unknown> }

async function nativeOwner(db: Db, request: Request): Promise<Owner | null> {
  const result = await db.execute<Owner>(sql`
    select id, status, input from openworkflow.workflow_runs
    where namespace_id = 'default' and workflow_name = 'repository-ingestion-orchestrator' and version is null
      and ${request.workflowRunId ? sql`id = ${request.workflowRunId}` : sql`idempotency_key = ${request.requestId}`}
      and input->>'orgId' = ${request.orgId} and input->>'repositoryId' = ${request.repositoryId}
    limit 1
  `)
  return result.rows[0] ?? null
}

/** Reserve immutable intent under the repository lock; do not publish queued before native admission. */
export async function prepareRepositoryIngestionRequest(
  input: RepositoryIngestionIntent & { afterRequestId?: string },
): Promise<Request> {
  return withOrgDbContext(input.orgId, async (db) => {
    const [repository] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, input.repositoryId))
      .for("update")
    if (!repository) throw new Error("Repository ingestion target missing")
    const [current] = await db
      .select()
      .from(repositoryIngestionRequests)
      .where(eq(repositoryIngestionRequests.repositoryId, input.repositoryId))
    if (current) {
      const owner = await nativeOwner(db, current)
      const sameBinding =
        current.repositoryUrl === repository.gitUrl &&
        current.githubConnectionId === repository.githubConnectionId
      const sameBranch = current.targetBranch === (input.targetBranch ?? null)
      if (
        sameBinding &&
        ((input.afterRequestId && current.requestId !== input.afterRequestId) ||
          (!input.afterRequestId &&
            sameBranch &&
            (!owner ||
              ["pending", "running", "sleeping"].includes(owner.status))))
      )
        return current
    }
    const request: Request = {
      repositoryId: input.repositoryId,
      orgId: input.orgId,
      requestId: randomUUID(),
      targetBranch: input.targetBranch ?? null,
      indexingReason: input.indexingReason ?? null,
      repositoryUrl: repository.gitUrl,
      githubConnectionId: repository.githubConnectionId,
      workflowRunId: null,
      createdAt: new Date(),
    }
    await db
      .insert(repositoryIngestionRequests)
      .values(request)
      .onConflictDoUpdate({
        target: repositoryIngestionRequests.repositoryId,
        set: request,
      })
    return request
  })
}

export async function findRepositoryIngestionOwner(input: {
  orgId: string
  repositoryId: string
  requestId: string
}): Promise<string | null> {
  return withOrgDbContext(input.orgId, async (db) => {
    const [request] = await db
      .select()
      .from(repositoryIngestionRequests)
      .where(
        and(
          eq(repositoryIngestionRequests.repositoryId, input.repositoryId),
          eq(repositoryIngestionRequests.requestId, input.requestId),
        ),
      )
    return request ? ((await nativeOwner(db, request))?.id ?? null) : null
  })
}

/** Both API acknowledgement and the first durable worker step use this CAS. */
export async function activateRepositoryIngestionRequest(
  input: RepositoryIngestionIntent & { requestId?: string },
  workflowRunId: string,
): Promise<string> {
  return withOrgDbContext(input.orgId, async (db) => {
    const [repository] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, input.repositoryId))
      .for("update")
    if (!repository) throw new Error("Repository ingestion target missing")
    const [current] = await db
      .select()
      .from(repositoryIngestionRequests)
      .where(eq(repositoryIngestionRequests.repositoryId, input.repositoryId))
    const requestId = input.requestId ?? `legacy:${workflowRunId}`
    if (current && current.requestId !== requestId)
      throw new Error("Repository ingestion request superseded")
    if (
      current &&
      (current.repositoryUrl !== repository.gitUrl ||
        current.githubConnectionId !== repository.githubConnectionId ||
        current.targetBranch !== (input.targetBranch ?? null))
    )
      throw new Error("Repository ingestion binding changed")
    const result = await db.execute<Owner>(
      sql`select id, status, input from openworkflow.workflow_runs where id = ${workflowRunId} and input->>'orgId' = ${input.orgId} and input->>'repositoryId' = ${input.repositoryId} and workflow_name = 'repository-ingestion-orchestrator' and namespace_id = 'default' and version is null`,
    )
    const owner = result.rows[0]
    if (
      !owner ||
      (input.requestId && owner.input.requestId !== input.requestId)
    )
      throw new Error("Repository ingestion native owner mismatch")
    const request: Request = {
      repositoryId: input.repositoryId,
      orgId: input.orgId,
      requestId,
      repositoryUrl: repository.gitUrl,
      githubConnectionId: repository.githubConnectionId,
      targetBranch: input.targetBranch ?? null,
      indexingReason: input.indexingReason ?? null,
      workflowRunId,
      createdAt: current?.createdAt ?? new Date(),
    }
    await db
      .insert(repositoryIngestionRequests)
      .values(request)
      .onConflictDoUpdate({
        target: repositoryIngestionRequests.repositoryId,
        set: { workflowRunId },
      })
    if (
      owner.status === "pending" ||
      (!current?.workflowRunId &&
        ["running", "sleeping"].includes(owner.status))
    )
      await db
        .update(repositories)
        .set({
          indexReady: sql`${repositories.lastIngestedHash} is not null`,
          indexingStatus: owner.status === "pending" ? "queued" : "running",
          indexingError: null,
          indexingFailedAt: null,
          indexingReason: input.indexingReason ?? null,
          indexingStep: null,
          indexingStepTotal: null,
          indexingStepKey: null,
        })
        .where(eq(repositories.id, input.repositoryId))
    return requestId
  })
}

/** A superseded or rebound producer cannot overwrite progress from the current request. */
export function repositoryIngestionWriteCondition(requestId?: string | null) {
  return requestId
    ? sql`exists (select 1 from repository_ingestion_requests request
        where request.repository_id = ${repositories.id} and request.org_id = ${repositories.orgId}
          and request.request_id = ${requestId} and request.repository_url = ${repositories.gitUrl}
          and request.github_connection_id is not distinct from ${repositories.githubConnectionId}
          and exists (select 1 from openworkflow.workflow_runs owner
            where owner.id = request.workflow_run_id
              and owner.namespace_id = 'default' and owner.version is null
              and owner.workflow_name = 'repository-ingestion-orchestrator'
              and owner.input->>'orgId' = request.org_id
              and owner.input->>'repositoryId' = request.repository_id
              and owner.status in ('pending', 'running', 'sleeping')))`
    : sql`not exists (select 1 from repository_ingestion_requests request
        where request.repository_id = ${repositories.id} and request.org_id = ${repositories.orgId})`
}

/** Recover a legacy child's authority from native parentage, then revalidate on every resume. */
export async function captureRepositoryIngestionRequest(
  input: RepositoryIngestionIntent & { requestId?: string },
  workflowRunId: string,
): Promise<string | null> {
  return withOrgDbContext(input.orgId, async (db) => {
    const [request] = await db
      .select()
      .from(repositoryIngestionRequests)
      .where(eq(repositoryIngestionRequests.repositoryId, input.repositoryId))
    if (!request) {
      if (input.requestId)
        throw new Error("Repository ingestion request missing")
      return null
    }
    let requestId = input.requestId
    if (!requestId) {
      const ancestors = await db.execute<{ id: string }>(sql`
        with recursive ancestry as (
          select id, parent_step_attempt_id, 0 as depth from openworkflow.workflow_runs
          where id = ${workflowRunId} and input->>'orgId' = ${input.orgId}
            and input->>'repositoryId' = ${input.repositoryId}
          union all
          select parent.id, parent.parent_step_attempt_id, child.depth + 1 from ancestry child
          join openworkflow.step_attempts attempt on attempt.id = child.parent_step_attempt_id
          join openworkflow.workflow_runs parent on parent.id = attempt.workflow_run_id
          where child.depth < 8 and parent.input->>'orgId' = ${input.orgId}
            and parent.input->>'repositoryId' = ${input.repositoryId}
        ) select id from ancestry where id = ${request.workflowRunId}
      `)
      if (ancestors.rows.length > 0) requestId = request.requestId
    }
    await assertRepositoryIngestionRequest({ ...input, requestId })
    return request.requestId
  })
}

/** Check the current immutable source binding before publishing or continuing captured work. */
export async function assertRepositoryIngestionRequest(input: {
  orgId: string
  repositoryId: string
  requestId?: string | null
  repositoryUrl?: string
  githubConnectionId?: string | null
}): Promise<void> {
  await withOrgDbContext(input.orgId, async (db) => {
    const [request] = await db
      .select()
      .from(repositoryIngestionRequests)
      .where(eq(repositoryIngestionRequests.repositoryId, input.repositoryId))
    if (!request && !input.requestId) return // Pre-upgrade direct extraction without a newer owner.
    if (!request || request.requestId !== input.requestId)
      throw new Error("Repository ingestion request superseded")
    const [repository] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, input.repositoryId))
    if (
      !repository ||
      repository.gitUrl !== request.repositoryUrl ||
      repository.githubConnectionId !== request.githubConnectionId ||
      (input.repositoryUrl !== undefined &&
        input.repositoryUrl !== request.repositoryUrl) ||
      (input.githubConnectionId !== undefined &&
        input.githubConnectionId !== request.githubConnectionId)
    )
      throw new Error("Repository ingestion binding changed")
    const owner = await nativeOwner(db, request)
    if (!owner || !["pending", "running", "sleeping"].includes(owner.status))
      throw new Error("Repository ingestion owner is no longer active")
  })
}
