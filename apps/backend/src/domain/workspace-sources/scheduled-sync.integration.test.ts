import { sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { encryptConnectionSecret } from "../../lib/connection-secrets.js"
import {
  listWorkspaceSourceRows,
  replaceWorkspaceSourceRows,
} from "../../models/workspace-sources.js"
import { PAGERDUTY_SYNC_MAX_TRIES } from "../../services/pagerduty/workspace-source-adapter.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { SOURCE_ADAPTERS } from "./adapter.js"
import type { SourceProvider } from "./sources-file.js"
import { syncConnectionSources, type WorkspaceSliceWrite } from "./sync.js"

// The OpenWorkflow client reads its namespace on import: keep these runs apart.
const namespaceId = vi.hoisted(() => {
  const id = `wsrc_daily_${Date.now()}_${Math.random().toString(36).slice(2)}`
  process.env.OPENWORKFLOW_NAMESPACE_ID = id
  return id
})

const API = "https://api.pagerduty.com"
const CHECKOUT = "PSVC001"
const GONE = "PSVC404"
const DAY_MS = 24 * 60 * 60 * 1000

const server = setupServer(
  http.get(`${API}/services/:serviceId`, ({ params }) =>
    params.serviceId === GONE
      ? HttpResponse.json({ error: "not found" }, { status: 404 })
      : HttpResponse.json({ service: { id: params.serviceId } }),
  ),
  http.get(`${API}/incidents`, () =>
    HttpResponse.json({ incidents: [{ id: "PINC001" }], more: false }),
  ),
  http.get(`${API}/incidents/:incidentId`, () =>
    HttpResponse.json({
      incident: {
        id: "PINC001",
        incident_number: 11,
        title: "Checkout is slow",
        html_url: "https://acme-test.pagerduty.com/incidents/PINC001",
        status: "triggered",
        service: { id: CHECKOUT, summary: CHECKOUT },
      },
    }),
  ),
  http.get(`${API}/incidents/:incidentId/alerts`, () =>
    HttpResponse.json({ alerts: [] }),
  ),
  http.get(`${API}/incidents/:incidentId/notes`, () =>
    HttpResponse.json({ notes: [] }),
  ),
)

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let enqueue: typeof import("./enqueue.js")
let backend: BackendPostgres

type QueuedSync = {
  id: string
  connectionId: string
  idempotencyKey: string | null
  availableAt: Date | null
  input: Record<string, unknown>
}

/** The source syncs queued in this test's namespace. */
async function queuedSyncs(connectionIds: string[]): Promise<QueuedSync[]> {
  const runs = await backend.listWorkflowRuns({ limit: 1000 })
  return runs.data
    .filter((run) => run.workflowName === "workspace-sources-sync")
    .map((run) => ({
      id: run.id,
      connectionId: String(
        (run.input as { connectionId?: string })?.connectionId,
      ),
      idempotencyKey: run.idempotencyKey,
      availableAt: run.availableAt,
      input: run.input as Record<string, unknown>,
    }))
    .filter((run) => connectionIds.includes(run.connectionId))
}

const pagerdutyConfig = () => ({
  accessTokenEnc: encryptConnectionSecret(
    "fixture-token",
    parseEnv(process.env),
  ),
  accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  accountId: "PACCT01",
  accountName: "Acme Test",
  accountSubdomain: "acme-test",
  region: "us",
  ownerUserId: "user_fixture",
  status: "installed",
})

async function addSource(input: {
  connectionId: string
  slug: string
  provider: SourceProvider
  scope: Record<string, unknown>
  status?: "ok" | "out_of_access"
}) {
  const workspaceId = await seed.addWorkspace(input.slug)
  await replaceWorkspaceSourceRows({
    orgId: seed.orgId,
    workspaceId,
    revision: "a".repeat(40),
    rows: [
      {
        sourceKey: input.slug,
        provider: input.provider,
        connectionId: input.connectionId,
        scope: input.scope,
        status: input.status ?? "ok",
        statusDetail: input.status === "out_of_access" ? "gone" : null,
      },
    ],
  })
  return workspaceId
}

describe("Scheduled full sync of Workspace sources (Postgres)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" })
    seed = await seedSourcesOrg("wsrc_daily")
    enqueue = await import("./enqueue.js")
    backend = await BackendPostgres.connect(process.env.DATABASE_URL ?? "", {
      runMigrations: false,
      namespaceId,
    })
  })
  afterAll(async () => {
    vi.useRealTimers()
    server.close()
    const { closeOpenWorkflowClient } = await import(
      "../../openworkflow/client.js"
    )
    await closeOpenWorkflowClient()
    await backend?.stop()
    await seed.cleanup()
  })

  it("queues one full sync per day for each connection with an ok source, spread over the day", async () => {
    const pagerduty = await seed.addConnection("pagerduty", pagerdutyConfig())
    const linear = await seed.addConnection("linear")
    const unused = await seed.addConnection("notion")
    const lost = await seed.addConnection("forge")
    const slack = await seed.addConnection("slack")
    await addSource({
      connectionId: pagerduty,
      slug: "daily-pd",
      provider: "pagerduty",
      scope: { services: [CHECKOUT] },
    })
    await addSource({
      connectionId: linear,
      slug: "daily-linear",
      provider: "linear",
      scope: { teams: ["ENG"] },
    })
    await addSource({
      connectionId: lost,
      slug: "daily-lost",
      provider: "confluence",
      scope: { spaces: ["HR"] },
      status: "out_of_access",
    })
    // Slack sources capture on demand: a full sync writes nothing.
    await addSource({
      connectionId: slack,
      slug: "daily-slack",
      provider: "slack",
      scope: { channels: ["C1"] },
    })
    const ids = [pagerduty, linear, unused, lost, slack]
    const today = new Date()
    const dayStart = Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate(),
    )

    await enqueue.enqueueDailySourcesSyncs(today)
    // A second scheduler run on the same day (a worker restart) adds nothing.
    await enqueue.enqueueDailySourcesSyncs(new Date(today.getTime() + 60_000))

    const first = await queuedSyncs(ids)
    expect(first.map((run) => run.connectionId).sort()).toEqual(
      [pagerduty, linear].sort(),
    )
    for (const run of first) {
      // A full sync: no webhook event.
      expect(run.input).toMatchObject({ kind: "connection", orgId: seed.orgId })
      expect(run.input.event).toBeUndefined()
      expect(run.availableAt?.getTime()).toBeGreaterThanOrEqual(
        dayStart - 60_000,
      )
      expect(run.availableAt?.getTime()).toBeLessThan(dayStart + 2 * DAY_MS)
    }
    expect(new Set(first.map((run) => run.availableAt?.getTime())).size).toBe(2)

    await enqueue.enqueueDailySourcesSyncs(new Date(today.getTime() + DAY_MS))
    const second = await queuedSyncs(ids)
    expect(second.filter((run) => run.connectionId === pagerduty)).toHaveLength(
      2,
    )
    expect(second.filter((run) => run.connectionId === linear)).toHaveLength(2)
  })

  it("marks a service deleted at PagerDuty out_of_access after the bounded daily syncs, and keeps its files", async () => {
    const connection = await seed.addConnection("pagerduty", pagerdutyConfig())
    const workspaceId = await addSource({
      connectionId: connection,
      slug: "daily-gone",
      provider: "pagerduty",
      scope: { services: [CHECKOUT, GONE] },
    })
    const goneRoot = `pagerduty/services/${GONE}/incidents/`
    const env = parseEnv(process.env)
    const start = Date.now() + 10 * DAY_MS
    const writes: WorkspaceSliceWrite[] = []

    for (let day = 0; day < PAGERDUTY_SYNC_MAX_TRIES; day += 1) {
      const now = new Date(start + day * DAY_MS)
      await enqueue.enqueueDailySourcesSyncs(now)
      const due = (await queuedSyncs([connection])).filter((run) =>
        run.idempotencyKey?.includes(now.toISOString().slice(0, 10)),
      )
      expect(due).toHaveLength(1)
      // Run the queued sync as the worker does, on its day.
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(now)
      const input = due[0]?.input as { orgId: string; connectionId: string }
      await syncConnectionSources({
        orgId: input.orgId,
        connectionId: input.connectionId,
        env,
        adapter: SOURCE_ADAPTERS.pagerduty ?? (undefined as never),
        write: async (write) => {
          writes.push(write)
        },
      })
      vi.useRealTimers()
    }

    const [row] = await listWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
    })
    expect(row?.status).toBe("out_of_access")
    expect(row?.statusDetail).toContain(GONE)
    expect(writes).toHaveLength(PAGERDUTY_SYNC_MAX_TRIES)
    for (const write of writes) {
      expect(write.keepPrefixes).toContain(goneRoot)
      expect(
        (write.deletePaths ?? []).filter((path) => path.startsWith(goneRoot)),
      ).toEqual([])
    }

    // With no ok source left, the next day queues nothing for it.
    const after = new Date(start + PAGERDUTY_SYNC_MAX_TRIES * DAY_MS)
    await enqueue.enqueueDailySourcesSyncs(after)
    expect(
      (await queuedSyncs([connection])).filter((run) =>
        run.idempotencyKey?.includes(after.toISOString().slice(0, 10)),
      ),
    ).toEqual([])
  })

  it("queues one scheduler run for each day, also after a worker restart more than one day after that run was queued", async () => {
    const { scheduleDailySourcesSync } = await import(
      "../../openworkflow/workflows/workspace-sources-daily-sync.js"
    )
    const day = new Date(Date.now() + 40 * DAY_MS)
    const dayKey = day.toISOString().slice(0, 10)
    const schedulerRuns = async () =>
      (await backend.listWorkflowRuns({ limit: 1000 })).data.filter(
        (run) =>
          run.workflowName === "workspace-sources-daily-sync" &&
          (run.input as { day?: string }).day === dayKey,
      )

    // The run of the previous day queues this run at its start.
    await scheduleDailySourcesSync(day)
    // The idempotency key of OpenWorkflow ends 24 hours after the queue time.
    await getSystemDb().execute(sql`
      update openworkflow.workflow_runs
      set created_at = created_at - interval '2 days'
      where namespace_id = ${namespaceId}
        and workflow_name = 'workspace-sources-daily-sync'
        and input->>'day' = ${dayKey}
    `)
    // A worker restart later on that day.
    await scheduleDailySourcesSync(new Date(day.getTime() + 60 * 60 * 1000))

    expect(await schedulerRuns()).toHaveLength(1)
  })

  it("starts one Sync now for a double click that crosses a minute boundary", async () => {
    const connection = await seed.addConnection("pagerduty", pagerdutyConfig())
    await addSource({
      connectionId: connection,
      slug: "sync-now-boundary",
      provider: "pagerduty",
      scope: { services: [CHECKOUT] },
    })
    // The next full minute: the first click is 1 ms before it, the second
    // click is on it.
    const boundary = (Math.floor(Date.now() / 60_000) + 1) * 60_000

    for (const at of [boundary - 1, boundary])
      expect(
        await enqueue.requestConnectionSourcesSync({
          orgId: seed.orgId,
          connectionId: connection,
          now: new Date(at),
        }),
      ).toBe(true)

    expect(await queuedSyncs([connection])).toHaveLength(1)
  })

  it("starts one Sync now for two clicks at the same time", async () => {
    const connection = await seed.addConnection("pagerduty", pagerdutyConfig())
    await addSource({
      connectionId: connection,
      slug: "sync-now-together",
      provider: "pagerduty",
      scope: { services: [CHECKOUT] },
    })
    const click = () =>
      enqueue.requestConnectionSourcesSync({
        orgId: seed.orgId,
        connectionId: connection,
        now: new Date(),
      })

    expect(await Promise.all([click(), click()])).toEqual([true, true])
    expect(await queuedSyncs([connection])).toHaveLength(1)
  })

  it("does not count a Sync now toward the bounded failure tries", async () => {
    const connection = await seed.addConnection("pagerduty", pagerdutyConfig())
    const workspaceId = await addSource({
      connectionId: connection,
      slug: "sync-now-gone",
      provider: "pagerduty",
      scope: { services: [CHECKOUT, GONE] },
    })
    const env = parseEnv(process.env)
    const start = Date.now() + 20 * DAY_MS

    // More clicks than the try limit, each more than one hour apart.
    for (let click = 0; click <= PAGERDUTY_SYNC_MAX_TRIES; click += 1) {
      const now = new Date(start + click * 2 * 60 * 60 * 1000)
      const before = await queuedSyncs([connection])
      expect(
        await enqueue.requestConnectionSourcesSync({
          orgId: seed.orgId,
          connectionId: connection,
          now,
        }),
      ).toBe(true)
      const queued = (await queuedSyncs([connection])).find(
        (run) => !before.some((old) => old.id === run.id),
      )
      const input = queued?.input as {
        orgId: string
        connectionId: string
        manual?: boolean
      }
      expect(input.manual).toBe(true)
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(now)
      await syncConnectionSources({
        orgId: input.orgId,
        connectionId: input.connectionId,
        env,
        adapter: SOURCE_ADAPTERS.pagerduty ?? (undefined as never),
        manual: input.manual,
        write: async () => undefined,
      })
      vi.useRealTimers()
    }

    const [row] = await listWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
    })
    expect(row?.status).toBe("ok")
  })
})
