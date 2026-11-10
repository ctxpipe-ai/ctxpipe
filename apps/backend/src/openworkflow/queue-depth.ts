import { type Meter, metrics, ValueType } from "@opentelemetry/api"
import { sql } from "drizzle-orm"

import { getSystemDb } from "../db/client.js"
import { log } from "../observability/logger.js"
import { openWorkflowNamespaceId } from "./namespace.js"

/**
 * The workflow runs of this namespace that wait for a worker now. This is
 * the claim rule of OpenWorkflow: a pending run, a sleeping run whose wake
 * time came, or a running run whose lease ended, before its deadline.
 */
async function openWorkflowQueueDepth(): Promise<number> {
  const { rows } = await getSystemDb().execute<{ ready: string }>(sql`
    select count(*) as ready
    from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()}
      and status in ('pending', 'running', 'sleeping')
      and available_at <= now()
      and (deadline_at is null or deadline_at > now())
  `)
  return Number(rows[0]?.ready ?? 0)
}

/**
 * One CloudWatch Embedded Metric Format line. On ECS, the awslogs driver
 * sends stdout to CloudWatch Logs, which turns the line into the metric
 * `ctxpipe` / `WorkerQueueDepth`. The worker autoscaling reads that metric.
 * The line has no dimensions, because production and the previews run in
 * separate accounts.
 */
function queueDepthEmfLine(depth: number): string {
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
    WorkerQueueDepth: depth,
  }
  return `${JSON.stringify(record)}\n`
}

/**
 * Sample the queue depth now and then once a minute. Each sample sets the
 * OTel gauge `openworkflow.queue.depth` (the dashboard). With `emf`, each
 * sample also writes the CloudWatch EMF line on stdout (the autoscaling);
 * that line is a metric record, not a log event, so it does not go through
 * evlog. The gauge reads the last sample, so a metric flush runs no SQL.
 * Each worker task reports the same depth: take the maximum, not the sum.
 */
export function startQueueDepthReports(
  emf: boolean,
  meter: Meter = metrics.getMeter("ctxpipe-backend"),
): { firstSample: Promise<void>; stop: () => void } {
  let depth: number | undefined
  meter
    .createObservableGauge("openworkflow.queue.depth", {
      description: "Workflow runs that wait for a worker",
      unit: "{run}",
      valueType: ValueType.INT,
    })
    .addCallback((result) => {
      if (depth !== undefined) result.observe(depth)
    })
  const sample = () =>
    openWorkflowQueueDepth()
      .then((next) => {
        depth = next
        if (emf) process.stdout.write(queueDepthEmfLine(next))
      })
      .catch((error: unknown) =>
        log.error({
          step: "openworkflow.queue-depth",
          message: `Reading the queue depth failed: ${String(error)}`,
        }),
      )
  const firstSample = sample()
  const timer = setInterval(() => void sample(), 60_000)
  timer.unref()
  return { firstSample, stop: () => clearInterval(timer) }
}
