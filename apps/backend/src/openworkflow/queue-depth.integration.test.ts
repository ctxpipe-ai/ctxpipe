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
import { observeOpenWorkflowQueue } from "./queue-depth.js"

const ids: string[] = []

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
})

afterAll(async () => {
  await getSystemDb().execute(
    sql`delete from openworkflow.workflow_runs where id in ${ids}`,
  )
  await closeDb()
})

/** One run row as OpenWorkflow writes it. `available` is seconds from now. */
async function insertRun(
  status: string,
  available: number | null,
  namespace = openWorkflowNamespaceId(),
  deadline: number | null = null,
) {
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

async function collect(): Promise<Record<string, number | undefined>> {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const provider = new MeterProvider({
    readers: [new FlushOnDemandMetricReader(exporter)],
  })
  observeOpenWorkflowQueue(provider.getMeter("queue-depth-test"))
  await provider.forceFlush()
  const values: Record<string, number | undefined> = {}
  for (const resource of exporter.getMetrics())
    for (const scope of resource.scopeMetrics)
      for (const metric of scope.metrics)
        values[metric.descriptor.name] = metric.dataPoints[0]?.value as number
  await provider.shutdown()
  return values
}

it("reports the runs that wait for a worker and the runs a worker holds", async () => {
  // Ready: a pending run, a sleeping run whose wake time came, and a
  // running run whose lease ended.
  await insertRun("pending", -5)
  await insertRun("sleeping", -5)
  await insertRun("running", -5)
  // Active: a running run with a live lease.
  await insertRun("running", 60)
  // Neither: a scheduled run, a sleeping run, a finished run, a run past its
  // deadline, and a run of another namespace.
  await insertRun("pending", 3_600)
  await insertRun("sleeping", 3_600)
  await insertRun("completed", null)
  await insertRun("pending", -5, openWorkflowNamespaceId(), -1)
  await insertRun("pending", -5, `other-${randomUUID()}`)

  expect(await collect()).toEqual({
    "openworkflow.queue.depth": 3,
    "openworkflow.runs.active": 1,
  })
})
