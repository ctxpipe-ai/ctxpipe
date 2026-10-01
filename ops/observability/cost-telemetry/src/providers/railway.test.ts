import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { isRecord } from "../http"
import { railwayBackupUsdPerGbMinute, railwayCpuUsdPerVcpuMinute, railwayEgressUsdPerGb, railwayMemoryUsdPerGbMinute, railwayVolumeUsdPerGbMinute } from "../rates"
import { utcDays } from "../rows"
import { useEnv } from "../test-env"
import { rows } from "./railway"

const DAY = "2026-09-25"
const productProjectId = "119e3cc3-ef73-43aa-895a-8c8ccff73ff8"
const OBSERVABILITY_PROJECT_ID = "obs-project-id"

const PRODUCT_PROJECT = {
  name: "ctxpipe",
  environments: { edges: [{ node: { id: "env-prod", name: "production" } }] },
  services: { edges: [{ node: { id: "svc-api", name: "api" } }] },
}
const OBSERVABILITY_PROJECT = {
  name: "observability",
  environments: { edges: [{ node: { id: "env-obs", name: "production" } }] },
  services: { edges: [{ node: { id: "svc-hdx", name: "hyperdx" } }] },
}

const server = setupServer()
useEnv({ RAILWAY_API_TOKEN: "railway-token", RAILWAY_PROJECT_ID: OBSERVABILITY_PROJECT_ID })

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" })
})
afterEach(() => {
  setSystemTime()
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

describe("railway rows", () => {
  test("maps usage and asserts day bounds", async () => {
    const usageCalls: Record<string, unknown>[] = []
    server.use(graphql(({ variables, query }) => {
      if (query.includes("query Project")) {
        expect(typeof variables.id).toBe("string")
        expect(variables.id === productProjectId || variables.id === OBSERVABILITY_PROJECT_ID).toBe(true)
        return projectData(variables.id === productProjectId ? PRODUCT_PROJECT : OBSERVABILITY_PROJECT)
      }
      expect(query).toContain("query Usage")
      usageCalls.push(variables)
      expect(variables.startDate).toBe("2026-09-25T00:00:00.000Z")
      expect(variables.endDate).toBe("2026-09-26T00:00:00.000Z")
      expect(variables.includeDeleted).toBe(true)
      expect(variables.groupBy).toEqual(["PROJECT_ID", "ENVIRONMENT_ID", "SERVICE_ID", "VOLUME_ID"])
      expect(variables.measurements).toEqual(["CPU_USAGE", "MEMORY_USAGE_GB", "NETWORK_TX_GB", "DISK_USAGE_GB", "BACKUP_USAGE_GB"])
      if (variables.projectId === productProjectId) {
        return usageData([
          { measurement: "CPU_USAGE", value: 100, tags: { environmentId: "env-prod", serviceId: "svc-api" } },
          { measurement: "MEMORY_USAGE_GB", value: 50, tags: { environmentId: "env-prod", serviceId: "svc-api" } },
          { measurement: "NETWORK_TX_GB", value: 2, tags: { environmentId: "env-prod", serviceId: "svc-api" } },
          { measurement: "DISK_USAGE_GB", value: 1000, tags: { environmentId: "env-prod", serviceId: "svc-api", volumeId: "vol-1" } },
          { measurement: "BACKUP_USAGE_GB", value: 200, tags: { environmentId: "env-prod", serviceId: "svc-api", volumeId: "vol-1" } },
        ])
      }
      return usageData([])
    }))
    const result = await rows([DAY])
    expect(usageCalls.map((call) => call.projectId).sort()).toEqual([OBSERVABILITY_PROJECT_ID, productProjectId].sort())
    expect(result).toEqual([
      {
        day: DAY,
        provider: "railway",
        sku: "cpu",
        scope: "ctxpipe/production/api",
        usage: 100,
        unit: "vcpu_min",
        costUsd: 100 * railwayCpuUsdPerVcpuMinute,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "railway",
        sku: "memory",
        scope: "ctxpipe/production/api",
        usage: 50,
        unit: "gb_min",
        costUsd: 50 * railwayMemoryUsdPerGbMinute,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "railway",
        sku: "egress",
        scope: "ctxpipe/production/api",
        usage: 2,
        unit: "GB",
        costUsd: 2 * railwayEgressUsdPerGb,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "railway",
        sku: "volume",
        scope: "ctxpipe/production/api",
        usage: 1000,
        unit: "gb_min",
        costUsd: 1000 * railwayVolumeUsdPerGbMinute,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "railway",
        sku: "backup",
        scope: "ctxpipe/production/api",
        usage: 200,
        unit: "gb_min",
        costUsd: 200 * railwayBackupUsdPerGbMinute,
        source: "estimated",
      },
    ])
  })

  test("falls back to ids for deleted services and skips zero usage", async () => {
    server.use(graphql(({ variables, query }) => {
      if (query.includes("query Project")) return projectData(String(variables.id) === productProjectId ? PRODUCT_PROJECT : OBSERVABILITY_PROJECT)
      if (variables.projectId !== productProjectId) return usageData([])
      return usageData([
        { measurement: "CPU_USAGE", value: 10, tags: { environmentId: "env-gone", serviceId: "svc-deleted" } },
        { measurement: "MEMORY_USAGE_GB", value: 0, tags: { environmentId: "env-prod", serviceId: "svc-api" } },
        { measurement: "NETWORK_TX_GB", value: 0, tags: { environmentId: "env-prod", serviceId: "svc-api" } },
      ])
    }))
    const result = await rows([DAY])
    expect(result.filter((row) => row.source === "estimated")).toEqual([
      {
        day: DAY,
        provider: "railway",
        sku: "cpu",
        scope: "ctxpipe/env-gone/svc-deleted",
        usage: 10,
        unit: "vcpu_min",
        costUsd: 10 * railwayCpuUsdPerVcpuMinute,
        source: "estimated",
      },
    ])
  })

  test("requests each UTC day in the shared window", async () => {
    setSystemTime(new Date("2026-09-26T12:00:00.000Z"))
    const bounds: { projectId: unknown; startDate: unknown; endDate: unknown }[] = []
    server.use(graphql(({ variables, query }) => {
      if (query.includes("query Project")) return projectData(String(variables.id) === productProjectId ? PRODUCT_PROJECT : OBSERVABILITY_PROJECT)
      bounds.push({ projectId: variables.projectId, startDate: variables.startDate, endDate: variables.endDate })
      return usageData([])
    }))
    await rows(utcDays(Date.now(), 3))
    const key = (row: { projectId: unknown; startDate: unknown }) => `${row.projectId}:${row.startDate}`
    expect(bounds.sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
      [
        { projectId: OBSERVABILITY_PROJECT_ID, startDate: "2026-09-24T00:00:00.000Z", endDate: "2026-09-25T00:00:00.000Z" },
        { projectId: OBSERVABILITY_PROJECT_ID, startDate: "2026-09-25T00:00:00.000Z", endDate: "2026-09-26T00:00:00.000Z" },
        { projectId: OBSERVABILITY_PROJECT_ID, startDate: "2026-09-26T00:00:00.000Z", endDate: "2026-09-27T00:00:00.000Z" },
        { projectId: productProjectId, startDate: "2026-09-24T00:00:00.000Z", endDate: "2026-09-25T00:00:00.000Z" },
        { projectId: productProjectId, startDate: "2026-09-25T00:00:00.000Z", endDate: "2026-09-26T00:00:00.000Z" },
        { projectId: productProjectId, startDate: "2026-09-26T00:00:00.000Z", endDate: "2026-09-27T00:00:00.000Z" },
      ].sort((a, b) => key(a).localeCompare(key(b))),
    )
  })

  test("throws on a non-OK response", async () => {
    server.use(http.post("https://backboard.railway.com/graphql/v2", () => new HttpResponse("nope", { status: 401 })))
    await expect(rows([DAY])).rejects.toThrow("Railway project HTTP 401: nope")
  })

  test("throws when usage is missing", async () => {
    server.use(graphql(({ query }) => {
      if (query.includes("query Project")) return projectData(PRODUCT_PROJECT)
      return HttpResponse.json({ data: {} })
    }))
    await expect(rows([DAY])).rejects.toThrow("Railway usage response was missing usage")
  })

  test("skips a malformed usage item", async () => {
    server.use(graphql(({ query, variables }) => {
      if (query.includes("query Project")) return projectData(String(variables.id) === productProjectId ? PRODUCT_PROJECT : OBSERVABILITY_PROJECT)
      if (variables.projectId !== productProjectId) return usageData([])
      return usageData([
        { measurement: "CPU_USAGE", value: 4, tags: { environmentId: "env-prod", serviceId: "svc-api" } },
        { measurement: "CPU_USAGE", value: "x", tags: { environmentId: "env-prod", serviceId: "svc-api" } },
        { measurement: "CPU_USAGE", value: 4, tags: null },
        null,
      ])
    }))
    const result = await rows([DAY])
    expect(result.filter((row) => row.sku === "cpu")).toEqual([
      {
        day: DAY,
        provider: "railway",
        sku: "cpu",
        scope: "ctxpipe/production/api",
        usage: 4,
        unit: "vcpu_min",
        costUsd: 4 * railwayCpuUsdPerVcpuMinute,
        source: "estimated",
      },
    ])
  })

  test("throws when the JSON body is null", async () => {
    server.use(http.post("https://backboard.railway.com/graphql/v2", () => HttpResponse.json(null)))
    await expect(rows([DAY])).rejects.toThrow("Railway project response was missing data")
  })

  test("throws when the API token is missing", async () => {
    delete process.env.RAILWAY_API_TOKEN
    await expect(rows([DAY])).rejects.toThrow("RAILWAY_API_TOKEN is required")
  })

  test("runs at most one usage query at a time", async () => {
    let inflight = 0
    let maxInflight = 0
    server.use(graphql(async ({ query, variables }) => {
      if (query.includes("query Project")) return projectData(String(variables.id) === productProjectId ? PRODUCT_PROJECT : OBSERVABILITY_PROJECT)
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      await Promise.resolve()
      inflight -= 1
      return usageData([])
    }))
    await rows(["2026-09-24", "2026-09-25", "2026-09-26"])
    expect(maxInflight).toBe(1)
  })

  test("retries a usage query concurrency limit once", async () => {
    let usageCalls = 0
    server.use(graphql(({ query, variables }) => {
      if (query.includes("query Project")) return projectData(String(variables.id) === productProjectId ? PRODUCT_PROJECT : OBSERVABILITY_PROJECT)
      usageCalls += 1
      if (usageCalls === 1) {
        return HttpResponse.json({
          errors: [{
            message: "Too many usage queries are running at once. Please retry in 0 seconds. Limit: 16 concurrent usage queries per client.",
          }],
        })
      }
      if (variables.projectId !== productProjectId) return usageData([])
      return usageData([
        { measurement: "CPU_USAGE", value: 10, tags: { environmentId: "env-prod", serviceId: "svc-api" } },
      ])
    }))
    await expect(rows([DAY])).resolves.toEqual([
      {
        day: DAY,
        provider: "railway",
        sku: "cpu",
        scope: "ctxpipe/production/api",
        usage: 10,
        unit: "vcpu_min",
        costUsd: 10 * railwayCpuUsdPerVcpuMinute,
        source: "estimated",
      },
    ])
    expect(usageCalls).toBe(3)
  })

  test("does not retry other GraphQL errors", async () => {
    let usageCalls = 0
    server.use(graphql(({ query, variables }) => {
      if (query.includes("query Project")) return projectData(String(variables.id) === productProjectId ? PRODUCT_PROJECT : OBSERVABILITY_PROJECT)
      usageCalls += 1
      return HttpResponse.json({ errors: [{ message: "usage is temporarily unavailable" }] })
    }))
    await expect(rows([DAY])).rejects.toThrow("usage is temporarily unavailable")
    expect(usageCalls).toBe(1)
  })

  test("gives up after one usage concurrency retry", async () => {
    let usageCalls = 0
    server.use(graphql(({ query, variables }) => {
      if (query.includes("query Project")) return projectData(String(variables.id) === productProjectId ? PRODUCT_PROJECT : OBSERVABILITY_PROJECT)
      usageCalls += 1
      return HttpResponse.json({
        errors: [{
          message: "Too many usage queries are running at once. Please retry in 0 seconds. Limit: 16 concurrent usage queries per client.",
        }],
      })
    }))
    await expect(rows([DAY])).rejects.toThrow("Too many usage queries are running at once")
    expect(usageCalls).toBe(2)
  })
})

function graphql(handler: (body: { query: string; variables: Record<string, unknown> }) => Response | Promise<Response>) {
  return http.post("https://backboard.railway.com/graphql/v2", async ({ request }) => {
    expect(request.headers.get("Authorization")).toBe("Bearer railway-token")
    const body: unknown = await request.json()
    if (!isRecord(body) || typeof body.query !== "string" || !isRecord(body.variables)) {
      return HttpResponse.json({ errors: [{ message: "bad request" }] }, { status: 400 })
    }
    return handler({ query: body.query, variables: body.variables })
  })
}

function projectData(project: unknown) {
  return HttpResponse.json({ data: { project } })
}

function usageData(usage: unknown[]) {
  return HttpResponse.json({ data: { usage } })
}
