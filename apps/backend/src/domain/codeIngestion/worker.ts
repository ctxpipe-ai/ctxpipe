import { and, eq, sql } from "drizzle-orm"
import {
  type Db,
  withOrgDbContext,
  withSystemDbContext,
} from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryIngestionErrors } from "../../db/schema/repositoryIngestionErrors.js"
import { repositoryIngestionQueue } from "../../db/schema/repositoryIngestionQueue.js"
import { graph as codeIngestionGraph } from "../../graphs/codeIngestionGraph/graph.js"
import { generateObjectId } from "../../lib/id.js"

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 5_000

type QueueJobRow = {
  id: string
  repositoryId: string
  orgId: string
  targetHash: string
  sourceBranch: string | null
  fromHash: string | null
  status: string
  attemptCount: number
}

export const CLAIM_NEXT_JOB_QUERY = `
SELECT
  q.id,
  q.repository_id AS "repositoryId",
  q.org_id AS "orgId",
  q.target_hash AS "targetHash",
  q.source_branch AS "sourceBranch",
  q.from_hash AS "fromHash",
  q.status,
  q.attempt_count AS "attemptCount"
FROM repository_ingestion_queue q
WHERE q.status = 'pending'
  AND q.available_at <= now()
  AND NOT EXISTS (
    SELECT 1
    FROM repository_ingestion_queue q2
    WHERE q2.repository_id = q.repository_id
      AND q2.created_at < q.created_at
      AND q2.status IN ('pending', 'processing')
  )
ORDER BY q.created_at
FOR UPDATE SKIP LOCKED
LIMIT 1
`

export function shouldMoveToErrorLog(attemptCount: number): boolean {
  return attemptCount + 1 >= MAX_ATTEMPTS
}

export function nextWorkerDelayMs(processed: boolean): number {
  return processed ? 100 : 1000
}

async function claimNextRepositoryIngestionJob(
  db: Db,
): Promise<QueueJobRow | null> {
  return db.transaction(async (tx) => {
    const result = await tx.execute<QueueJobRow>(sql.raw(CLAIM_NEXT_JOB_QUERY))
    const job = result.rows[0] ?? null
    if (!job) {
      return null
    }
    await tx
      .update(repositoryIngestionQueue)
      .set({
        status: "processing",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(repositoryIngestionQueue.id, job.id))
    return {
      ...job,
      status: "processing",
    }
  })
}

async function markJobSuccess(db: Db, job: QueueJobRow) {
  await db
    .update(repositories)
    .set({
      indexReady: true,
      lastIngestedHash: job.targetHash,
      updatedAt: new Date(),
    })
    .where(eq(repositories.id, job.repositoryId))
  await db
    .delete(repositoryIngestionQueue)
    .where(eq(repositoryIngestionQueue.id, job.id))
}

async function markJobFailure(db: Db, job: QueueJobRow, errorMessage: string) {
  const nextAttemptCount = job.attemptCount + 1
  if (shouldMoveToErrorLog(job.attemptCount)) {
    await db.insert(repositoryIngestionErrors).values({
      id: generateObjectId("inge"),
      queueJobId: job.id,
      repositoryId: job.repositoryId,
      orgId: job.orgId,
      targetHash: job.targetHash,
      sourceBranch: job.sourceBranch,
      fromHash: job.fromHash,
      attemptCount: nextAttemptCount,
      errorMessage,
    })
    await db
      .delete(repositoryIngestionQueue)
      .where(eq(repositoryIngestionQueue.id, job.id))
    return
  }
  await db
    .update(repositoryIngestionQueue)
    .set({
      status: "pending",
      attemptCount: nextAttemptCount,
      availableAt: new Date(Date.now() + RETRY_DELAY_MS),
      lastError: errorMessage,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(repositoryIngestionQueue.id, job.id),
        eq(repositoryIngestionQueue.status, "processing"),
      ),
    )
}

export async function processOneCodeIngestionJob(): Promise<boolean> {
  return withSystemDbContext(async (db) => {
    const job = await claimNextRepositoryIngestionJob(db)
    if (!job) {
      return false
    }

    await withOrgDbContext(job.orgId, async (orgDb) => {
      try {
        await codeIngestionGraph.invoke({
          repositoryId: job.repositoryId,
          orgId: job.orgId,
          fromHash: job.fromHash ?? undefined,
          sourceBranch: job.sourceBranch ?? undefined,
          targetHash: job.targetHash,
        })
        await markJobSuccess(orgDb, job)
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Code ingestion failed"
        await markJobFailure(orgDb, job, errorMessage)
      }
    })
    return true
  })
}

let workerStarted = false
let workerTimer: ReturnType<typeof setTimeout> | null = null

export function startCodeIngestionWorker() {
  if (workerStarted) return
  workerStarted = true

  const tick = async () => {
    if (!workerStarted) return

    try {
      const processed = await processOneCodeIngestionJob()
      if (!workerStarted) return
      workerTimer = setTimeout(tick, nextWorkerDelayMs(processed))
    } catch {
      if (!workerStarted) return
      workerTimer = setTimeout(tick, nextWorkerDelayMs(false))
    }
  }

  void tick()
}

export function stopCodeIngestionWorker() {
  workerStarted = false
  if (!workerTimer) return
  clearTimeout(workerTimer)
  workerTimer = null
}
