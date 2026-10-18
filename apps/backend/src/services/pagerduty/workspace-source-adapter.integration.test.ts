import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import {
  syncConnectionSources,
  type WorkspaceSliceWrite,
} from "../../domain/workspace-sources/sync.js"
import { parsePagerdutyConnectionStored } from "../../lib/connection-config.js"
import { encryptConnectionSecret } from "../../lib/connection-secrets.js"
import {
  listWorkspaceSourceRows,
  replaceWorkspaceSourceRows,
} from "../../models/workspace-sources.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import {
  PAGERDUTY_SYNC_MAX_TRIES,
  pagerdutySourceAdapter,
} from "./workspace-source-adapter.js"

const API = "https://api.pagerduty.com"
const CHECKOUT = "PSVC001"
const BILLING = "PSVC002"
const GONE = "PSVC404"

/** The PagerDuty account that msw serves. */
const pd = {
  /** Incidents by id: number and service. */
  incidents: new Map<
    string,
    { number: number; serviceId: string; title: string }
  >([
    ["PINC001", { number: 11, serviceId: CHECKOUT, title: "Checkout is slow" }],
    ["PINC002", { number: 12, serviceId: CHECKOUT, title: "Checkout errors" }],
    ["PINC003", { number: 13, serviceId: BILLING, title: "Invoices stuck" }],
  ]),
  /** A status for a service read, for example 404 or 503. */
  serviceStatus: new Map<string, number>(),
  unauthorized: false,
  reads: [] as string[],
}

const unauthorized = () =>
  pd.unauthorized
    ? HttpResponse.json({ error: "unauthorized" }, { status: 401 })
    : undefined

const server = setupServer(
  http.get(`${API}/services/:serviceId`, ({ params }) => {
    const serviceId = String(params.serviceId)
    pd.reads.push(`service:${serviceId}`)
    const status = pd.serviceStatus.get(serviceId)
    return (
      unauthorized() ??
      (status
        ? HttpResponse.json({ error: "failed" }, { status })
        : HttpResponse.json({ service: { id: serviceId, name: serviceId } }))
    )
  }),
  http.get(`${API}/incidents`, ({ request }) => {
    const serviceId = new URL(request.url).searchParams.get("service_ids[]")
    pd.reads.push(`list:${serviceId}`)
    return (
      unauthorized() ??
      HttpResponse.json({
        incidents: [...pd.incidents]
          .filter(([, incident]) => incident.serviceId === serviceId)
          .map(([id]) => ({ id })),
        more: false,
      })
    )
  }),
  http.get(`${API}/incidents/:incidentId`, ({ params }) => {
    const incidentId = String(params.incidentId)
    pd.reads.push(`incident:${incidentId}`)
    const incident = pd.incidents.get(incidentId)
    if (!incident) return HttpResponse.json({}, { status: 404 })
    return (
      unauthorized() ??
      HttpResponse.json({
        incident: {
          id: incidentId,
          incident_number: incident.number,
          title: incident.title,
          html_url: `https://acme-test.pagerduty.com/incidents/${incidentId}`,
          status: "triggered",
          service: { id: incident.serviceId, summary: incident.serviceId },
        },
      })
    )
  }),
  http.get(`${API}/incidents/:incidentId/alerts`, () =>
    HttpResponse.json({
      alerts: [{ id: "PALERT1", summary: "CPU high", body: { details: {} } }],
    }),
  ),
  http.get(`${API}/incidents/:incidentId/notes`, () =>
    HttpResponse.json({ notes: [] }),
  ),
)

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let env: ReturnType<typeof parseEnv>

const installed = () => ({
  accessTokenEnc: encryptConnectionSecret("fixture-token", env),
  accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  accountId: "PACCT01",
  accountName: "Acme Test",
  accountSubdomain: "acme-test",
  region: "us",
  ownerUserId: "user_fixture",
  status: "installed",
})

async function addSource(
  connectionId: string,
  slug: string,
  services: string[],
) {
  const workspaceId = await seed.addWorkspace(slug)
  await replaceWorkspaceSourceRows({
    orgId: seed.orgId,
    workspaceId,
    revision: "a".repeat(40),
    rows: [
      {
        sourceKey: slug,
        provider: "pagerduty",
        connectionId,
        scope: { services },
        status: "ok",
        statusDetail: null,
      },
    ],
  })
  return workspaceId
}

async function sync(
  connectionId: string,
  extra: { event?: unknown; blobs?: Array<{ path: string; sha: string }> } = {},
) {
  const writes: WorkspaceSliceWrite[] = []
  await withLogger(createLogger({ test: "pagerduty-sources" }), () =>
    syncConnectionSources({
      orgId: seed.orgId,
      connectionId,
      env,
      adapter: pagerdutySourceAdapter,
      event: extra.event,
      readExisting: extra.blobs ? async () => extra.blobs ?? [] : undefined,
      write: async (write) => {
        writes.push(write)
      },
    }),
  )
  return new Map(writes.map((write) => [write.workspaceId, write]))
}

const paths = (write: WorkspaceSliceWrite | undefined) =>
  (write?.files ?? []).map((file) => file.path).sort()

const incidentPath = (serviceId: string, number: number, id: string) =>
  `pagerduty/services/${serviceId}/incidents/${number}--${id}.md`

const blobSha = (content: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest("hex")

async function storedConfig(connectionId: string) {
  const [row] = await withOrgDbContext(seed.orgId, (db) =>
    db
      .select({ config: connections.config })
      .from(connections)
      .where(eq(connections.id, connectionId)),
  )
  return parsePagerdutyConnectionStored(row?.config as Record<string, unknown>)
}

describe("PagerDuty source adapter (Postgres + msw)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" })
    seed = await seedSourcesOrg("wsrc_pagerduty")
    env = parseEnv(process.env)
  })
  afterEach(() => {
    vi.useRealTimers()
    pd.unauthorized = false
    pd.reads.length = 0
    pd.serviceStatus.clear()
  })
  afterAll(async () => {
    server.close()
    await seed.cleanup()
  })

  it("fetches each service once and writes each Workspace only its services", async () => {
    const connection = await seed.addConnection("pagerduty", installed())
    const shop = await addSource(connection, "pd-shop", [CHECKOUT])
    const both = await addSource(connection, "pd-both", [CHECKOUT, BILLING])
    const money = await addSource(connection, "pd-money", [BILLING])

    const writes = await sync(connection)

    expect(pd.reads.filter((read) => read === `list:${CHECKOUT}`)).toHaveLength(
      1,
    )
    expect(paths(writes.get(shop))).toEqual([
      incidentPath(CHECKOUT, 11, "PINC001"),
      incidentPath(CHECKOUT, 12, "PINC002"),
    ])
    expect(paths(writes.get(money))).toEqual([
      incidentPath(BILLING, 13, "PINC003"),
    ])
    expect(paths(writes.get(both))).toHaveLength(3)
    expect(writes.get(both)?.ownedPrefixes).toEqual(
      [
        `pagerduty/services/${CHECKOUT}/incidents/`,
        `pagerduty/services/${BILLING}/incidents/`,
      ].sort(),
    )
    const markdown = writes.get(shop)?.files[0]?.content ?? ""
    expect(markdown).toContain("Checkout is slow")
    expect(markdown).toContain("CPU high")
  })

  it("skips unchanged files and deletes stale incidents as a patch", async () => {
    const connection = await seed.addConnection("pagerduty", installed())
    const shop = await addSource(connection, "pd-patch", [CHECKOUT])
    const first = (await sync(connection)).get(shop)
    const kept = first?.files.find((file) => file.path.includes("PINC001"))
    const stale = incidentPath(CHECKOUT, 9, "PINCOLD")

    const writes = await sync(connection, {
      blobs: [
        { path: kept?.path ?? "", sha: blobSha(kept?.content ?? "") },
        { path: stale, sha: blobSha("old") },
        // The legacy mirror folder is not a managed path; it stays.
        { path: "pagerduty/incidents/9--PINCOLD.md", sha: blobSha("old") },
      ],
    })

    const write = writes.get(shop)
    expect(paths(write)).toEqual([incidentPath(CHECKOUT, 12, "PINC002")])
    expect(write?.deletePaths).toEqual([stale])
  })

  it("syncs only the incident of a webhook event, for the matching sources", async () => {
    const connection = await seed.addConnection("pagerduty", installed())
    const shop = await addSource(connection, "pd-event-shop", [CHECKOUT])
    const money = await addSource(connection, "pd-event-money", [BILLING])

    const writes = await sync(connection, {
      event: { incidentId: "PINC002", serviceId: CHECKOUT },
      blobs: [],
    })

    expect(pd.reads).toEqual(["incident:PINC002"])
    expect(writes.has(money)).toBe(false)
    expect(paths(writes.get(shop))).toEqual([
      incidentPath(CHECKOUT, 12, "PINC002"),
    ])
    expect(writes.get(shop)?.deletePaths).toEqual([])
  })

  it("deletes the files of an incident that is gone", async () => {
    const connection = await seed.addConnection("pagerduty", installed())
    const shop = await addSource(connection, "pd-event-gone", [CHECKOUT])
    const gone = incidentPath(CHECKOUT, 99, "PINC099")

    const writes = await sync(connection, {
      event: { incidentId: "PINC099", serviceId: CHECKOUT },
      blobs: [{ path: gone, sha: blobSha("old") }],
    })

    expect(writes.get(shop)?.files).toEqual([])
    expect(writes.get(shop)?.deletePaths).toEqual([gone])
  })

  it("keeps a missing service, counts only permanent failures, then marks only its source", async () => {
    const connection = await seed.addConnection("pagerduty", installed())
    const shop = await addSource(connection, "pd-fail-shop", [CHECKOUT])
    const mixed = await addSource(connection, "pd-fail-mixed", [GONE, BILLING])

    // An outage keeps the copy and does not count.
    pd.serviceStatus.set(GONE, 503)
    let writes = await sync(connection)
    expect(writes.get(mixed)?.keepPrefixes).toEqual([
      `pagerduty/services/${GONE}/incidents/`,
    ])
    expect((await storedConfig(connection)).sourceSync?.failures).toEqual({})

    pd.serviceStatus.set(GONE, 404)
    vi.useFakeTimers({ toFake: ["Date"] })
    for (let cycle = 1; cycle <= PAGERDUTY_SYNC_MAX_TRIES; cycle += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 12, cycle * 2)))
      writes = await sync(connection)
      // The other services and Workspaces still sync.
      expect(paths(writes.get(shop))).toHaveLength(2)
      expect(paths(writes.get(mixed))).toEqual([
        incidentPath(BILLING, 13, "PINC003"),
      ])
      expect(writes.get(mixed)?.keepPrefixes).toEqual([
        `pagerduty/services/${GONE}/incidents/`,
      ])
    }

    const [row] = await listWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: mixed,
    })
    expect(row?.status).toBe("out_of_access")
    expect(row?.statusDetail).toContain(
      `PagerDuty service ${GONE} does not exist`,
    )
    const [shopRow] = await listWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: shop,
    })
    expect(shopRow?.status).toBe("ok")
  })

  it("counts a burst of failing syncs in one hour one time", async () => {
    const connection = await seed.addConnection("pagerduty", installed())
    const gone = await addSource(connection, "pd-burst", [GONE])
    pd.serviceStatus.set(GONE, 403)
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 12, 9)))
    for (let cycle = 0; cycle < PAGERDUTY_SYNC_MAX_TRIES + 1; cycle += 1)
      await sync(connection)
    expect(
      (await storedConfig(connection)).sourceSync?.failures[`service:${GONE}`]
        ?.tries,
    ).toBe(1)
    const [row] = await listWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: gone,
    })
    expect(row?.status).toBe("ok")
  })

  it("does not hide a missing service behind an outage of another", async () => {
    const connection = await seed.addConnection("pagerduty", installed())
    pd.serviceStatus.set(GONE, 404)
    pd.serviceStatus.set(BILLING, 503)

    const detail = await pagerdutySourceAdapter.checkAccess?.({
      orgId: seed.orgId,
      connectionId: connection,
      scope: { services: [BILLING, GONE, CHECKOUT] },
      env,
    })

    expect(detail).toBe(
      `PagerDuty service ${GONE} does not exist. Remove it from the source.`,
    )
    pd.serviceStatus.clear()
    expect(
      await pagerdutySourceAdapter.checkAccess?.({
        orgId: seed.orgId,
        connectionId: connection,
        scope: { services: [CHECKOUT] },
        env,
      }),
    ).toBeNull()
  })

  it("keeps every file and marks the connection revoked when PagerDuty refuses its token", async () => {
    const connection = await seed.addConnection("pagerduty", installed())
    const shop = await addSource(connection, "pd-revoked", [CHECKOUT])
    pd.unauthorized = true

    const writes = await sync(connection)

    expect(writes.has(shop)).toBe(false)
    expect((await storedConfig(connection)).status).toBe("revoked")
    expect(
      await pagerdutySourceAdapter.syncStatus?.({
        orgId: seed.orgId,
        connectionId: connection,
        scope: { services: [CHECKOUT] },
      }),
    ).toEqual({
      status: "out_of_access",
      detail: expect.stringMatching(/Reconnect PagerDuty/),
    })
  })

  it("moves an incident from the Workspace of its old service to the new one", async () => {
    const connection = await seed.addConnection("pagerduty", installed())
    const shop = await addSource(connection, "pd-move-shop", [CHECKOUT])
    const money = await addSource(connection, "pd-move-money", [BILLING])
    const old = incidentPath(CHECKOUT, 11, "PINC001")
    pd.incidents.set("PINC001", {
      number: 11,
      serviceId: BILLING,
      title: "Checkout is slow",
    })
    try {
      const writes = await sync(connection, {
        event: { incidentId: "PINC001", serviceId: BILLING },
        blobs: [{ path: old, sha: blobSha("old") }],
      })

      expect(writes.get(shop)?.files).toEqual([])
      expect(writes.get(shop)?.deletePaths).toEqual([old])
      expect(paths(writes.get(money))).toEqual([
        incidentPath(BILLING, 11, "PINC001"),
      ])
    } finally {
      pd.incidents.set("PINC001", {
        number: 11,
        serviceId: CHECKOUT,
        title: "Checkout is slow",
      })
    }
  })

  it("keeps a hostile incident id from the provider under the service folder", async () => {
    const connection = await seed.addConnection("pagerduty", installed())
    const shop = await addSource(connection, "pd-hostile", [BILLING])
    const hostile = "../../../../.ctxpipe/workspace"
    pd.incidents.set(hostile, {
      number: 21,
      serviceId: BILLING,
      title: "Hostile id",
    })
    try {
      const writes = await sync(connection)

      const written = paths(writes.get(shop))
      const folder = `pagerduty/services/${BILLING}/incidents/`
      expect(written).toContain(
        `${folder}21---.-..-..-..-.ctxpipe-workspace.md`,
      )
      for (const path of written) {
        expect(path.startsWith(folder)).toBe(true)
        expect(
          path.split("/").some((part) => ["", ".", ".."].includes(part)),
        ).toBe(false)
      }
    } finally {
      pd.incidents.delete(hostile)
    }
  })

  it("does not fetch an incident that no source has or selects", async () => {
    const connection = await seed.addConnection("pagerduty", installed())
    await addSource(connection, "pd-event-other", [CHECKOUT])

    const writes = await sync(connection, {
      event: { incidentId: "PINC777", serviceId: "PSVC999" },
      blobs: [],
    })

    expect(pd.reads).toEqual([])
    expect(writes.size).toBe(0)
  })

  it("matches each incident event, so the fetch can move or delete files", () => {
    const scope = { services: [CHECKOUT] }
    const match = (event: unknown) =>
      pagerdutySourceAdapter.matchesEvent?.({ event, scope })
    expect(match({ incidentId: "PINC003", serviceId: BILLING })).toBe(true)
    expect(match({ incidentId: "PINC003" })).toBe(false)
  })
})
