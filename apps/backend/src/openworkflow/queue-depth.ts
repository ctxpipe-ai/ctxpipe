import { type Meter, metrics, ValueType } from "@opentelemetry/api"
import { sql } from "drizzle-orm"

import { getSystemDb } from "../db/client.js"
import { openWorkflowNamespaceId } from "./namespace.js"

/**
 * The workflow runs of this namespace that wait for a worker now (`ready`),
 * and the runs that a worker holds now (`active`). `ready` uses the claim
 * rule of OpenWorkflow: a pending run, a sleeping run whose wake time came,
 * or a running run whose lease ended, before its deadline.
 */
async function openWorkflowQueueCounts(): Promise<{
  ready: number
  active: number
}> {
  const { rows } = await getSystemDb().execute<{
    ready: string
    active: string
  }>(sql`
    select
      count(*) filter (where available_at <= now()) as ready,
      count(*) filter (where status = 'running' and available_at > now()) as active
    from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()}
      and status in ('pending', 'running', 'sleeping')
      and (deadline_at is null or deadline_at > now())
  `)
  return {
    ready: Number(rows[0]?.ready ?? 0),
    active: Number(rows[0]?.active ?? 0),
  }
}

/**
 * Report the queue as two gauges each time the metric reader collects:
 * `openworkflow.queue.depth` (the scaling signal of the worker) and
 * `openworkflow.runs.active`. Each worker task reports the same counts, so a
 * query or a scaling rule takes their maximum, not their sum.
 */
export function observeOpenWorkflowQueue(
  meter: Meter = metrics.getMeter("ctxpipe-backend"),
): void {
  const depth = meter.createObservableGauge("openworkflow.queue.depth", {
    description: "Workflow runs that wait for a worker",
    unit: "{run}",
    valueType: ValueType.INT,
  })
  const active = meter.createObservableGauge("openworkflow.runs.active", {
    description: "Workflow runs that a worker holds",
    unit: "{run}",
    valueType: ValueType.INT,
  })
  meter.addBatchObservableCallback(
    async (result) => {
      const counts = await openWorkflowQueueCounts()
      result.observe(depth, counts.ready)
      result.observe(active, counts.active)
    },
    [depth, active],
  )
}

/**
 * Write the queue depth once as a CloudWatch Embedded Metric Format line.
 * On ECS, the awslogs driver sends stdout to CloudWatch Logs, which turns
 * the line into the metric `ctxpipe` / `WorkerQueueDepth`, and the worker
 * autoscaling reads that metric. The line has no dimensions, because
 * production and the previews run in separate accounts. This is a metric
 * record, not a log event, so it does not go through evlog.
 */
export async function writeQueueDepthEmf(
  write: (line: string) => void = (line) => void process.stdout.write(line),
): Promise<void> {
  const { ready } = await openWorkflowQueueCounts()
  const record = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: "ctxpipe",
          Dimensions: [[]],
          Metrics: [{ Name: "WorkerQueueDepth", Unit: "Count" }],
        },
      ],
    },
    WorkerQueueDepth: ready,
  }
  write(`${JSON.stringify(record)}\n`)
}
