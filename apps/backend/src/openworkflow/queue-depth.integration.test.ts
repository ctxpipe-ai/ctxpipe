import { randomUUID } from "node:crypto"

import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
} from "@opentelemetry/sdk-metrics"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"

import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { FlushOnDemandMetricReader } from "../observability/flushOnDemandMetricReader.js"
import { openWorkflowNamespaceId } from "./namespace.js"
import { startQueueDepthReports } from "./queue-depth.js"

const ids: string[] = []

// The test setup gives each file its own OpenWorkflow namespace
// (`src/test/setup-openworkflow-runs.ts`), so runs of other files do not
// change these counts.
beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
  // Ready: a pending run, a sleeping run whose wake time came, and a
  // running run whose lease ended.
  await insertRun({ status: "pending", availableInSeconds: -5 })
  await insertRun({ status: "sleeping", availableInSeconds: -5 })
  await insertRun({ status: "running", availableInSeconds: -5 })
  // Not ready: a running run with a live lease, a scheduled run, a
  // sleeping run, a finished run, a run past its deadline, and a run of
  // another namespace.
  await insertRun({ status: "running", availableInSeconds: 60 })
  await insertRun({ status: "pending", availableInSeconds: 3_600 })
  await insertRun({ status: "sleeping", availableInSeconds: 3_600 })
  await insertRun({ status: "completed", availableInSeconds: null })
  await insertRun({
    status: "pending",
    availableInSeconds: -5,
    deadlineInSeconds: -1,
  })
  await insertRun({
    status: "pending",
    availableInSeconds: -5,
    namespace: `other-${randomUUID()}`,
  })
})

afterAll(async () => {
  await getSystemDb().execute(
    sql`delete from openworkflow.workflow_runs where id in ${ids}`,
  )
  await closeDb()
})

/** One run row as OpenWorkflow writes it. The times are seconds from now. */
async function insertRun(run: {
  status: string
  availableInSeconds: number | null
  deadlineInSeconds?: number
  namespace?: string
}) {
  const {
    status,
    availableInSeconds: available,
    deadlineInSeconds: deadline = null,
    namespace = openWorkflowNamespaceId(),
  } = run
  const id = randomUUID()
  ids.push(id)
  await getSystemDb().execute(sql`
    insert into openworkflow.workflow_runs
      (namespace_id, id, workflow_name, status, config, attempts,
       available_at, deadline_at, created_at, updated_at)
    values
      (${namespace}, ${id}, 'queue-depth-probe', ${status}, '{}'::jsonb, 0,
       ${available === null ? null : sql`now() + ${available} * interval '1 second'`},
       ${deadline === null ? null : sql`now() + ${deadline} * interval '1 second'`},
       now(), now())
  `)
}

/** Start the reports once, and return the gauge value and the stdout lines. */
async function report(emf: boolean) {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const provider = new MeterProvider({
    readers: [new FlushOnDemandMetricReader(exporter)],
  })
  const lines: string[] = []
  const reports = startQueueDepthReports(
    emf ? (line) => lines.push(line) : undefined,
    provider.getMeter("test"),
  )
  await reports.firstSample
  reports.stop()
  await provider.forceFlush()
  const points = exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === "openworkflow.queue.depth")
    .flatMap((metric) => metric.dataPoints.map((point) => point.value))
  await provider.shutdown()
  return { points, lines }
}

it("reports the runs that wait for a worker as a gauge", async () => {
  const { points, lines } = await report(false)

  expect(points).toEqual([3])
  expect(lines).toEqual([])
})

it("also writes the depth as one CloudWatch EMF line with no dimensions", async () => {
  const { lines } = await report(true)

  expect(lines).toHaveLength(1)
  expect(lines[0]?.endsWith("\n")).toBe(true)
  expect(JSON.parse(lines[0] ?? "")).toEqual({
    _aws: {
      Timestamp: expect.any(Number),
      CloudWatchMetrics: [
        {
          Namespace: "ctxpipe",
          Dimensions: [[]],
          Metrics: [{ Name: "WorkerQueueDepth", Unit: "Count" }],
        },
      ],
    },
    WorkerQueueDepth: 3,
  })
})
