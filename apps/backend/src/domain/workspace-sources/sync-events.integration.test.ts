import { sql } from "drizzle-orm"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import {
  emptyLinearPage,
  installLinearGraphql,
  type LinearGraphqlCall,
  linearIssueData,
} from "../../../test/linear-graphql.js"
import { useMswServer } from "../../../test/msw.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { encodeLinearTokensForDb } from "../../lib/connection-config.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { resetLinearGraphqlForTests } from "../../services/linear/graphql.js"
import { linearSourceAdapter } from "../../services/linear/source-adapter.js"
import { linearSourceEventFromPayload } from "../../services/linear/source-event.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { syncQueuedSourceEvents } from "./sync-events.js"
import { syncConnectionSources, type WorkspaceSliceWrite } from "./sync.js"

/**
 * CTX-1595: the webhooks of one Linear connection wait together for one
 * coalesced sources sync. Real Postgres and OpenWorkflow; msw is Linear.
 */
const server = useMswServer()
const calls: LinearGraphqlCall[] = []
const env = () => parseEnv(process.env)
let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let workspaceId: string
let backend: BackendPostgres

// Loaded after DATABASE_URL is checked: the OpenWorkflow client connects on import.
const workflow = () =>
  import("../../openworkflow/workflows/workspace-sources-sync.js")

const issueEvent = (n: number) =>
  linearSourceEventFromPayload(
    {
      type: "Issue",
      action: "update",
      data: { id: `issue-${n}`, identifier: `OPS-${n}`, projectId: null },
    },
    { entityType: "issue", externalId: `issue-${n}`, action: "upsert" },
  )

async function linearConnection(): Promise<string> {
  const connectionId = await seed.addConnection("linear", {
    ...encodeLinearTokensForDb(
      { accessToken: "linear-access", refreshToken: null },
      env(),
    ),
    workspaceId: `linear-org-${seed.suffix}`,
    workspaceName: "Example",
    workspaceUrlKey: "example",
    status: "installed",
  })
  return connectionId
}

async function addSource(connectionId: string): Promise<void> {
  await replaceWorkspaceSourceRows({
    orgId: seed.orgId,
    workspaceId,
    revision: "e".repeat(40),
    rows: [
      {
        sourceKey: `ops-${connectionId}`,
        provider: "linear",
        connectionId,
        scope: { teams: ["OPS"] },
        status: "ok",
        statusDetail: null,
      },
    ],
  })
}

type Run = {
  id: string
  status: string
  input: Record<string, unknown>
  availableAt: Date | null
}

/** The source syncs of one connection in this file's namespace, oldest first. */
async function syncRuns(connectionId: string): Promise<Run[]> {
  const result = await getSystemDb().execute<Run>(sql`
    select id, status, input, available_at as "availableAt"
    from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()}
      and workflow_name = 'workspace-sources-sync'
      and input->>'connectionId' = ${connectionId}
    order by created_at, id
  `)
  return result.rows
}

/** Run one coalesced sync as the workflow does, and keep its writes. */
async function runCoalescedSync(
  connectionId: string,
  runId: string,
  during?: () => Promise<void>,
  existing: string[] = [],
) {
  const writes: WorkspaceSliceWrite[] = []
  const synced = await syncQueuedSourceEvents({
    orgId: seed.orgId,
    connectionId,
    runId,
    adapter: linearSourceAdapter,
    sync: async (event) => {
      await during?.()
      return syncConnectionSources({
        orgId: seed.orgId,
        connectionId,
        env: env(),
        adapter: linearSourceAdapter,
        event,
        write: async (write) => {
          writes.push(write)
        },
        readExisting: async () =>
          existing.map((path) => ({ path, sha: "0".repeat(40) })),
      })
    },
  })
  if (synced.busy) throw new Error("Another sync of the connection runs")
  const paths = writes.flatMap((write) => write.files.map((file) => file.path))
  const deletePaths = writes.flatMap((write) => write.deletePaths ?? [])
  return { events: synced.events, writes, paths: paths.sort(), deletePaths }
}

const issuePath = (n: number) =>
  `linear/teams/OPS/issues/ops-${n}--issue-${n}.md`

describe("coalesced sources syncs of Linear webhooks (Postgres, msw)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("sync_events")
    workspaceId = await seed.addWorkspace("ops")
    backend = await BackendPostgres.connect(process.env.DATABASE_URL ?? "", {
      runMigrations: false,
      namespaceId: openWorkflowNamespaceId(),
    })
  })

  afterAll(async () => {
    await backend?.stop()
    await seed?.cleanup()
    const { closeOpenWorkflowClient } =
      await import("../../openworkflow/client.js")
    await closeOpenWorkflowClient()
  })

  beforeEach(() => {
    resetLinearGraphqlForTests()
    calls.length = 0
    installLinearGraphql(server, calls, (call) => {
      if (call.name === "DiscoverScopes")
        return {
          teams: emptyLinearPage([
            { id: "team-ops", key: "OPS", name: "Operations" },
          ]),
        }
      if (call.name.startsWith("IssueRecord") || call.name === "Issue") {
        const id = String(call.variables.id)
        if (id === "issue-broken") throw new Error("Linear cannot read it")
        return {
          issue: linearIssueData({
            id,
            identifier: `OPS-${id.slice("issue-".length)}`,
            teamId: "team-ops",
          }),
        }
      }
      return {}
    })
  })

  it("gives one waiting sync for a burst of webhooks, and keeps other connections apart", async () => {
    const { queueSourceSyncEvent } = await workflow()
    const first = await linearConnection()
    const second = await linearConnection()
    await addSource(first)
    const queue = (connectionId: string, n: number) =>
      queueSourceSyncEvent({
        orgId: seed.orgId,
        connectionId,
        provider: "linear",
        event: issueEvent(n),
      })
    const started = Date.now()
    await Promise.all([1, 2, 3, 4, 5, 6].map((n) => queue(first, n)))
    await queue(second, 7)

    const runs = await syncRuns(first)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.input).toMatchObject({
      kind: "connection",
      provider: "linear",
      queuedEvents: true,
    })
    expect(runs[0]?.input).not.toHaveProperty("event")
    // The sync waits for the window, so that more webhooks join it.
    expect(new Date(String(runs[0]?.availableAt)).getTime()).toBeGreaterThan(
      started + 9 * 60_000,
    )
    expect(await syncRuns(second)).toHaveLength(1)

    const synced = await runCoalescedSync(first, runs[0]?.id ?? "")
    expect(synced.events).toBe(6)
    // One sync, one write: each issue of the burst, from the incremental mirror.
    expect(synced.writes).toHaveLength(1)
    expect(synced.paths).toEqual([1, 2, 3, 4, 5, 6].map(issuePath).sort())
    expect(calls.some((call) => call.name.startsWith("TeamIssues"))).toBe(false)
    // The other connection keeps its own event.
    const other = await runCoalescedSync(second, "run-of-another-connection")
    expect(other.events).toBe(1)
  })

  it("syncs an event that comes while a sync runs in one next sync", async () => {
    const { queueSourceSyncEvent } = await workflow()
    const connectionId = await linearConnection()
    await addSource(connectionId)
    const queue = (n: number) =>
      queueSourceSyncEvent({
        orgId: seed.orgId,
        connectionId,
        provider: "linear",
        event: issueEvent(n),
      })
    await queue(1)
    await queue(2)
    const [running] = await syncRuns(connectionId)

    let whileRunning: unknown
    const first = await runCoalescedSync(
      connectionId,
      running?.id ?? "",
      async () => {
        await Promise.all([queue(3), queue(4)])
        // The next sync cannot start while this one runs: it takes nothing.
        const [, next] = await syncRuns(connectionId)
        whileRunning = await syncQueuedSourceEvents({
          orgId: seed.orgId,
          connectionId,
          runId: next?.id ?? "",
          adapter: linearSourceAdapter,
          sync: async () => {
            throw new Error("Two syncs of one connection ran at the same time")
          },
        })
      },
    )
    expect(whileRunning).toEqual({ busy: true })
    expect(first.paths).toEqual([issuePath(1), issuePath(2)])

    // One next sync waits behind the running one.
    const runs = await syncRuns(connectionId)
    expect(runs).toHaveLength(2)
    const next = await runCoalescedSync(connectionId, runs[1]?.id ?? "")
    expect(next.paths).toEqual([issuePath(3), issuePath(4)])
    // Nothing waits after that.
    expect((await runCoalescedSync(connectionId, "a-later-run")).events).toBe(0)
  })

  it("deletes a removed issue also when another issue of the same sync fails", async () => {
    const { queueSourceSyncEvent } = await workflow()
    const connectionId = await linearConnection()
    await addSource(connectionId)
    const queue = (event: unknown) =>
      queueSourceSyncEvent({
        orgId: seed.orgId,
        connectionId,
        provider: "linear",
        event,
      })
    await queue(
      linearSourceEventFromPayload(
        {
          type: "Issue",
          action: "remove",
          data: { id: "issue-8", identifier: "OPS-8", projectId: null },
        },
        { entityType: "issue", externalId: "issue-8", action: "delete" },
      ),
    )
    await queue(
      linearSourceEventFromPayload(
        {
          type: "Issue",
          action: "update",
          data: { id: "issue-broken", identifier: "OPS-9", projectId: null },
        },
        { entityType: "issue", externalId: "issue-broken", action: "upsert" },
      ),
    )
    const [run] = await syncRuns(connectionId)
    const synced = await runCoalescedSync(
      connectionId,
      run?.id ?? "",
      undefined,
      [issuePath(8)],
    )
    expect(synced.events).toBe(2)
    expect(synced.deletePaths).toEqual([issuePath(8)])
  })

  it("lets a coalesced sync sleep, with no slot and no events, while another sync of the connection runs", async () => {
    const { queueSourceSyncEvent, workspaceSourcesSync } = await workflow()
    const { enqueueWorkflow } = await import("../../openworkflow/client.js")
    const connectionId = await linearConnection()
    await addSource(connectionId)
    await queueSourceSyncEvent({
      orgId: seed.orgId,
      connectionId,
      provider: "linear",
      event: issueEvent(1),
    })
    const [first] = await syncRuns(connectionId)
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let inside = () => {}
    const entered = new Promise<void>((resolve) => {
      inside = resolve
    })
    const running = runCoalescedSync(connectionId, first?.id ?? "", () => {
      inside()
      return released
    })
    // The first sync took its events and runs.
    await entered
    // A next sync that is due now, while the first one runs.
    await queueSourceSyncEvent({
      orgId: seed.orgId,
      connectionId,
      provider: "linear",
      event: issueEvent(2),
    })
    const { workflowRun: next } = await enqueueWorkflow(
      workspaceSourcesSync.spec,
      {
        kind: "connection",
        orgId: seed.orgId,
        connectionId,
        provider: "linear",
        queuedEvents: true,
      },
    )
    const runner = new OpenWorkflow({ backend })
    runner.implementWorkflow(workspaceSourcesSync.spec, workspaceSourcesSync.fn)
    const worker = runner.newWorker({ concurrency: 1 })
    await worker.start()
    try {
      const deadline = Date.now() + 30_000
      for (;;) {
        // A sleep keeps the run "running", with a start time later than now
        // and no worker that holds it.
        const sleeping = await getSystemDb().execute(sql`
          select 1 from openworkflow.workflow_runs run
          join openworkflow.step_attempts step on step.workflow_run_id = run.id
          where run.id = ${next.id}
            and step.step_name = 'await-running-sync-1'
            and run.worker_id is null
            and run.available_at > now()
        `)
        if (sleeping.rows.length) break
        if (Date.now() > deadline)
          throw new Error("The next sync did not sleep")
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    } finally {
      await worker.stop()
      release()
    }
    expect((await running).paths).toEqual([issuePath(1)])
    // The sleeping sync took no event: event 2 still waits for it.
    expect((await runCoalescedSync(connectionId, next.id)).paths).toEqual([
      issuePath(2),
    ])
  }, 60_000)

  it("hands the event of each sync queued before coalescing to one coalesced sync", async () => {
    const { workspaceSourcesSync } = await workflow()
    const { enqueueWorkflow } = await import("../../openworkflow/client.js")
    const connectionId = await linearConnection()
    await addSource(connectionId)
    // The backlog that the deploy finds: one sync for each webhook.
    for (const n of [1, 2, 3, 4, 5])
      await enqueueWorkflow(workspaceSourcesSync.spec, {
        kind: "connection",
        orgId: seed.orgId,
        connectionId,
        provider: "linear",
        event: issueEvent(n),
      })

    const runner = new OpenWorkflow({ backend })
    runner.implementWorkflow(workspaceSourcesSync.spec, workspaceSourcesSync.fn)
    const worker = runner.newWorker({ concurrency: 2 })
    await worker.start()
    try {
      const deadline = Date.now() + 30_000
      for (;;) {
        const old = (await syncRuns(connectionId)).filter(
          (run) => run.input.event !== undefined,
        )
        if (old.every((run) => run.status === "completed")) break
        if (Date.now() > deadline) throw new Error("The old syncs did not end")
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    } finally {
      await worker.stop()
    }
    // The old syncs read nothing from Linear and wrote nothing.
    expect(calls).toEqual([])
    const coalesced = (await syncRuns(connectionId)).filter(
      (run) => run.input.queuedEvents === true,
    )
    expect(coalesced).toHaveLength(1)
    expect(coalesced[0]?.status).toBe("pending")

    const synced = await runCoalescedSync(connectionId, coalesced[0]?.id ?? "")
    expect(synced.writes).toHaveLength(1)
    expect(synced.paths).toEqual([1, 2, 3, 4, 5].map(issuePath).sort())
  }, 60_000)
})
