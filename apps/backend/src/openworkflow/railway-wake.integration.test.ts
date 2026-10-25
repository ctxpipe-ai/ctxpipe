import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { useMswServer } from "../../test/msw.js"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { scheduleEnsureWorkerRunning } from "./railway-wake.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local"), quiet: true })

// A PR number of its own gives this file its own OpenWorkflow namespace.
const pr = `pr-${Date.now()}${Math.floor(Math.random() * 1000)}`
const namespace = `preview-${pr}`

const requests: { headers: Headers; body: { query: string } }[] = []
useMswServer(
  http.post("https://backboard.railway.com/graphql/v2", async ({ request }) => {
    const body = (await request.json()) as { query: string }
    requests.push({ headers: request.headers, body })
    if (body.query.includes("ProjectServices")) {
      return HttpResponse.json({
        data: {
          project: {
            services: {
              edges: [{ node: { id: "svc_worker", name: "openworkflow" } }],
            },
          },
        },
      })
    }
    return HttpResponse.json({ data: { serviceInstanceDeployV2: true } })
  }),
)

async function insertRun(input: {
  id: string
  workerId: string | null
  availableAt: Date
}): Promise<void> {
  await getSystemDb().execute(sql`
    insert into openworkflow.workflow_runs
      (namespace_id, id, workflow_name, status, config, attempts, worker_id,
       available_at, started_at, created_at, updated_at)
    values
      (${namespace}, ${input.id}, 'ingestion-shard', 'running', '{}'::jsonb, 1,
       ${input.workerId}, ${input.availableAt.toISOString()}::timestamptz,
       now(), now(), now())
  `)
}

beforeAll(() => {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required")
  initDb(connectionString)
})

beforeEach(() => {
  requests.length = 0
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", pr)
  vi.stubEnv("RAILWAY_TOKEN", "scoped-project-token")
  vi.stubEnv("RAILWAY_PROJECT_ID", "proj_test")
  vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "env_preview")
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await getSystemDb().execute(
    sql`delete from openworkflow.workflow_runs where namespace_id = ${namespace}`,
  )
  await closeDb()
})

// This test runs first: a skip does not start the 2-minute debounce, and a
// deploy does.
it("does not redeploy the worker while it holds a live run lease", async () => {
  await insertRun({
    id: "run-leased",
    workerId: "worker-alive",
    availableAt: new Date(Date.now() + 30_000),
  })
  // A parked parent run has no worker. It is not a live lease.
  await insertRun({
    id: "run-parked",
    workerId: null,
    availableAt: new Date(Date.now() + 365 * 24 * 3600_000),
  })

  await scheduleEnsureWorkerRunning()

  expect(requests).toEqual([])
})

it("wakes the preview worker with the environment-scoped project token when no lease is live", async () => {
  // The worker of this lease stopped, so the lease ended.
  await getSystemDb().execute(sql`
    update openworkflow.workflow_runs
    set available_at = now() - interval '1 minute'
    where namespace_id = ${namespace} and id = 'run-leased'
  `)

  await scheduleEnsureWorkerRunning()

  expect(requests).toHaveLength(2)
  expect(requests[1]?.body.query).toContain("serviceInstanceDeployV2")
  for (const { headers } of requests) {
    expect(headers.get("project-access-token")).toBe("scoped-project-token")
    expect(headers.get("authorization")).toBeNull()
  }
})
