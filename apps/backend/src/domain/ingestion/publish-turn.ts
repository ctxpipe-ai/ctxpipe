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
 *
 * A newer push run of the same source replaces a push run (CTX-1040): the
 * check gives the newer run's id, and the run ends before it calls a model.
 * Both push runs target each Workspace of the source, and the newer commit
 * includes the older one. A re-ingestion run names its Workspace in
 * `destinations`, so it is never replaced. A newer run that ended does not
 * replace a run.
 */
export async function ingestPublishTurn(input: {
  orgId: string
  runId: string
  sourceUrl: string
  /** The Workspaces of the run; undefined is each Workspace of the source. */
  destinations: readonly string[] | undefined
}): Promise<{ turn: true } | { wait: string } | { superseded: string }> {
  if (!input.destinations) {
    const newer = await getSystemDb().execute<{ id: string }>(sql`
      select other.id
      from openworkflow.workflow_runs other, openworkflow.workflow_runs me
      where me.namespace_id = ${openWorkflowNamespaceId()}
        and me.id = ${input.runId}
        and other.namespace_id = me.namespace_id
        and other.workflow_name = ${INGESTION_V2_WORKFLOW_NAME}
        and other.status in ('pending', 'running', 'sleeping')
        and other.input->>'orgId' = ${input.orgId}
        and other.input->>'shadow' = 'false'
        and other.input->'destinations' is null
        and lower(other.input->'source'->>'url') = ${input.sourceUrl.toLowerCase()}
        and (other.created_at, other.id) > (me.created_at, me.id)
      order by other.created_at desc, other.id desc
      limit 1
    `)
    const id = newer.rows[0]?.id
    if (id) return { superseded: id }
  }
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
 * A first step, `publish-turn-deadline`, stores `deadlineAt`, 60 minutes after
 * the run start. It does no I/O, so it does not fail and retry. Each check
 * reads that stored value, so a retry of a check (which moves the engine's
 * `startedAt`) or a replay does not move the deadline (CTX-964). A run that
 * an earlier release started keeps the `deadlineAt` in its stored first
 * check. After the deadline the run goes on: the merge model
 * then joins the two publishes. The worker can claim a sleeping run minutes
 * late, so a count of polls is not a time limit. A check that finds a newer
 * run that replaces this run stops the wait at once (CTX-1040).
 */
export async function waitForPublishTurn(options: {
  /** The `step` of the workflow; openworkflow does not export its type. */
  step: {
    run<T>(config: { name: string }, fn: () => Promise<T>): Promise<T>
    sleep(name: string, duration: "60 seconds"): Promise<void>
  }
  /** The engine start of the run; null when the engine has not set it. */
  startedAt: Date | null
  check: () => Promise<
    { turn: true } | { wait: string } | { superseded: string }
  >
  now?: () => number
}): Promise<
  | { outcome: "turn" | "deadline"; checks: number }
  | { outcome: "superseded"; checks: number; newer: string }
> {
  const now = options.now ?? Date.now
  const stored = await options.step.run(
    { name: "publish-turn-deadline" },
    async () => ({
      deadlineAt:
        (options.startedAt?.getTime() ?? now()) + PUBLISH_TURN_WAIT_MS,
    }),
  )
  let deadlineAt = stored.deadlineAt
  for (let check = 0; ; check++) {
    const result = await options.step.run(
      { name: `publish-turn:${check}` },
      async (): Promise<
        | { turn: true }
        | { superseded: string }
        | { wait: string; expired: boolean; deadlineAt?: number }
      > => {
        trace.getActiveSpan()?.setAttributes({
          "ctxpipe.wait.reason": "earlier-run-of-source",
          "ctxpipe.wait.check": check,
        })
        const turn = await options.check()
        if ("turn" in turn || "superseded" in turn) return turn
        return { ...turn, expired: now() >= deadlineAt }
      },
    )
    if ("turn" in result) return { outcome: "turn", checks: check + 1 }
    if ("superseded" in result)
      return {
        outcome: "superseded",
        checks: check + 1,
        newer: result.superseded,
      }
    // A check stored by an earlier release carries its own deadline.
    deadlineAt = result.deadlineAt ?? deadlineAt
    if (result.expired) return { outcome: "deadline", checks: check + 1 }
    await options.step.sleep(`wait-publish-turn:${check}`, "60 seconds")
  }
}
