import { createHash } from "node:crypto"
import { and, desc, eq, sql } from "drizzle-orm"
import { requireCurrentOrgId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import { workspaces, workspaceWriteJobs } from "../db/schema/workspaces.js"
import type { WorkspaceRevision } from "../domain/workspaces/revision.js"
import type { WorkspaceWriteKind } from "../domain/workspaces/write-commit-files.js"
import { WRITE_JOB_RETRY_CAP_PER_SHA } from "../domain/workspaces/write-jobs.js"
import { orgSql } from "./workspace-sql.js"

/** Reserve intents only; native typed workflows own execution, retry and completion. */
export async function reserveHydrateWrites(input: {
  revision: WorkspaceRevision
  remaining: Array<{ kind: WorkspaceWriteKind; remainder: number }>
}) {
  return orgSql(async () => {
    const db = getOrgDb()
    const revision = { ...input.revision, access: "write-default" as const }
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, revision.workspaceId))
      .for("update")
    if (
      !workspace ||
      workspace.desiredGeneration !== revision.generation ||
      workspace.workspaceRepositoryUrl !== revision.remote.url ||
      workspace.githubConnectionId !== revision.remote.connectionId ||
      workspace.desiredDefaultBranch !== revision.defaultBranch ||
      workspace.desiredSha !== revision.sha
    )
      return []
    const binding = and(
      eq(workspaceWriteJobs.workspaceId, revision.workspaceId),
      eq(workspaceWriteJobs.generation, revision.generation),
      sql`${workspaceWriteJobs.payload}->'revision'->'remote' = ${JSON.stringify(revision.remote)}::jsonb`,
      sql`${workspaceWriteJobs.payload}->'revision'->>'defaultBranch' = ${revision.defaultBranch}`,
    )
    const [publisher] = await db
      .select({ payload: workspaceWriteJobs.payload })
      .from(workspaceWriteJobs)
      .where(and(binding, eq(workspaceWriteJobs.commitSha, revision.sha)))
      .orderBy(desc(workspaceWriteJobs.createdAt))
      .limit(1)
    const rootSha = publisher?.payload?.planning?.rootSha ?? revision.sha
    const reserved: Array<{ kind: WorkspaceWriteKind; jobId: string }> = []
    for (const { kind, remainder } of input.remaining) {
      if (remainder <= 0) continue
      const [previous] = await db
        .select()
        .from(workspaceWriteJobs)
        .where(
          and(
            binding,
            eq(workspaceWriteJobs.kind, kind),
            sql`${workspaceWriteJobs.payload}->'planning'->>'rootSha' = ${rootSha}`,
          ),
        )
        .orderBy(
          desc(
            sql`(${workspaceWriteJobs.payload}->'planning'->>'attempt')::integer`,
          ),
        )
        .limit(1)
      if (
        previous?.desiredSha === revision.sha &&
        ["queued", "paused"].includes(previous.status)
      ) {
        reserved.push({ kind, jobId: previous.id })
        continue
      }
      const prior = previous?.payload?.planning
      if (
        previous &&
        (!prior ||
          previous.status !== "completed" ||
          prior.attempt >= WRITE_JOB_RETRY_CAP_PER_SHA ||
          remainder >= prior.remainder)
      )
        continue
      const planning = {
        rootSha,
        remainder,
        attempt: (prior?.attempt ?? 0) + 1,
      }
      const jobId = `wjob_${createHash("sha256")
        .update(
          JSON.stringify({
            ...revision,
            sha: rootSha,
            kind,
            attempt: planning.attempt,
          }),
        )
        .digest("hex")}`
      await db.insert(workspaceWriteJobs).values({
        id: jobId,
        orgId: requireCurrentOrgId(),
        workspaceId: revision.workspaceId,
        kind,
        generation: revision.generation,
        desiredSha: revision.sha,
        status: "paused",
        payload: {
          revision,
          jobWorkspaceUrl: revision.remote.url,
          defaultBranch: revision.defaultBranch,
          planning,
        },
      })
      reserved.push({ kind, jobId })
    }
    return reserved
  })
}
