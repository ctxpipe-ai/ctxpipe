import { trace } from "@opentelemetry/api"
import { sql } from "drizzle-orm"
import { getSystemDb } from "../../db/client.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { INGESTION_V2_WORKFLOW_NAME } from "./ingestion-run.js"

/**
 * The turn of an ingestion v2 run to pin its Workspace revisions (CTX-895).
 * Two runs of one source that pin the same revision race at publish: the
 * later publish finds each file of the run changed on the default branch,
 * and only the merge model can join them. So a run waits while an earlier
 * active run of the same source (not a shadow run) can publish to one of its
 * Workspaces, for example a push during a re-ingestion. It then pins the
 * revision that the earlier run published. A run waits only for an earlier
 * run, so two runs never wait for each other.
 */
export async function ingestPublishTurn(input: {
  orgId: string
  runId: string
  sourceUrl: string
  /** The Workspaces of the run; undefined is each Workspace of the source. */
  destinations: readonly string[] | undefined
}): Promise<{ turn: true } | { wait: string }> {
  const result = await getSystemDb().execute<{ earlier: string }>(sql`
    select count(*) as earlier
    from openworkflow.workflow_runs other, openworkflow.workflow_runs me
    where me.namespace_id = ${openWorkflowNamespaceId()}
      and me.id = ${input.runId}
      and other.namespace_id = me.namespace_id
      and other.workflow_name = ${INGESTION_V2_WORKFLOW_NAME}
      and other.status in ('pending', 'running', 'sleeping')
      and other.input->>'orgId' = ${input.orgId}
      and other.input->>'shadow' = 'false'
      and lower(other.input->'source'->>'url') = ${input.sourceUrl.toLowerCase()}
      and (other.created_at, other.id) < (me.created_at, me.id)
      and ${
        input.destinations
          ? sql`(other.input->'destinations' is null
              or exists (select 1
                from jsonb_array_elements_text(other.input->'destinations') d
                where d in (${sql.join(
                  input.destinations.map((id) => sql`${id}`),
                  sql`, `,
                )})))`
          : sql`true`
      }
  `)
  return Number(result.rows[0]?.earlier ?? 0) > 0
    ? {
        wait: "An earlier ingestion run of this source publishes to the same Workspace. This run starts after it.",
      }
    : { turn: true }
}

/** A run waits at most this long for an earlier run (CTX-964). */
export const PUBLISH_TURN_WAIT_MS = 60 * 60_000

/**
 * Wait for the publish turn of a run (CTX-895). The run checks each minute.
 * The first check stores `deadlineAt`, 60 minutes after the run start, in its
 * step output. Each later check reads that stored value, so a step retry
 * (which moves the engine's `startedAt`) or a replay does not move the
 * deadline (CTX-964). After the deadline the run goes on: the merge model
 * then joins the two publishes. The worker can claim a sleeping run minutes
 * late, so a count of polls is not a time limit.
 */
export async function waitForPublishTurn(options: {
  /** The `step` of the workflow; openworkflow does not export its type. */
  step: {
    run<T>(config: { name: string }, fn: () => Promise<T>): Promise<T>
    sleep(name: string, duration: "60 seconds"): Promise<void>
  }
  /** The engine start of the run; null when the engine has not set it. */
  startedAt: Date | null
  check: () => Promise<{ turn: true } | { wait: string }>
  now?: () => number
}): Promise<{ outcome: "turn" | "deadline"; checks: number }> {
  const now = options.now ?? Date.now
  let deadlineAt: number | undefined
  for (let check = 0; ; check++) {
    const result = await options.step.run(
      { name: `publish-turn:${check}` },
      async () => {
        trace.getActiveSpan()?.setAttributes({
          "ctxpipe.wait.reason": "earlier-run-of-source",
          "ctxpipe.wait.check": check,
        })
        const turn = await options.check()
        if ("turn" in turn) return turn
        const at =
          deadlineAt ??
          (options.startedAt?.getTime() ?? now()) + PUBLISH_TURN_WAIT_MS
        return { ...turn, deadlineAt: at, expired: now() >= at }
      },
    )
    if ("turn" in result) return { outcome: "turn", checks: check + 1 }
    deadlineAt = result.deadlineAt
    if (result.expired) return { outcome: "deadline", checks: check + 1 }
    await options.step.sleep(`wait-publish-turn:${check}`, "60 seconds")
  }
}
