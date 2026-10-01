import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { isRecord } from "../http"
import { cloudflareR2StorageUsdPerGbMonth } from "../rates"
import { utcDays } from "../rows"
import { useEnv } from "../test-env"
import { rows } from "./cloudflare"

const DAY = "2026-02-04"
const ACCOUNT = "cf-account"

const server = setupServer()
useEnv({ CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: ACCOUNT })

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

describe("cloudflare rows", () => {
  test("classifies action types, converts storage with a 30-day GB-month, and splits a partial free-tier day by bucket", async () => {
    let variables: Record<string, unknown> = {}
    server.use(
      graphql((body) => {
        variables = body.variables
        expect(body.query).toContain("r2StorageAdaptiveGroups")
        expect(body.query).toContain("r2OperationsAdaptiveGroups")
        return data({
          storage: [
            storage("2026-02-01", "logs", 224_000_000_000, 0),
            storage(DAY, "logs", 56_000_000_000, 0),
            storage(DAY, "assets", 28_000_000_000, 0),
          ],
          operations: [
            operation("2026-02-01", "logs", "PutObject", 600_000),
            operation(DAY, "logs", "PutObject", 300_000),
            operation(DAY, "assets", "ListObjects", 300_000),
            operation(DAY, "logs", "GetObject", 10_000_000),
            operation(DAY, "assets", "HeadObject", 1_000_000),
            operation(DAY, "logs", "DeleteObject", 50),
          ],
        })
      }),
    )
    const result = await rows([DAY])
    expect(variables).toEqual({ accountTag: ACCOUNT, start: "2026-02-01", end: DAY })
    const logsGbMonth = 56_000_000_000 / 1_000_000_000 / 30
    const assetsGbMonth = 28_000_000_000 / 1_000_000_000 / 30
    const priorGbMonth = 224_000_000_000 / 1_000_000_000 / 30
    const dayGbMonth = logsGbMonth + assetsGbMonth
    const billedGbMonth = priorGbMonth + dayGbMonth - 10
    expect(result).toEqual([
      {
        day: DAY,
        provider: "cloudflare",
        sku: "r2_storage",
        scope: "logs",
        usage: (logsGbMonth / dayGbMonth) * billedGbMonth,
        unit: "gb_month",
        costUsd: (logsGbMonth / dayGbMonth) * cloudflareR2StorageUsdPerGbMonth,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "cloudflare",
        sku: "r2_storage",
        scope: "assets",
        usage: (assetsGbMonth / dayGbMonth) * billedGbMonth,
        unit: "gb_month",
        costUsd: (assetsGbMonth / dayGbMonth) * cloudflareR2StorageUsdPerGbMonth,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "cloudflare",
        sku: "r2_class_a",
        scope: "logs",
        usage: 100_000,
        unit: "requests",
        costUsd: 2.25,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "cloudflare",
        sku: "r2_class_a",
        scope: "assets",
        usage: 100_000,
        unit: "requests",
        costUsd: 2.25,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "cloudflare",
        sku: "r2_class_b",
        scope: "logs",
        usage: 10_000_000 / 11,
        unit: "requests",
        costUsd: (10 / 11) * 0.36,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "cloudflare",
        sku: "r2_class_b",
        scope: "assets",
        usage: 1_000_000 / 11,
        unit: "requests",
        costUsd: (1 / 11) * 0.36,
        source: "estimated",
      },
    ])
  })

  test("uses a fixed 30-day GB-month", async () => {
    server.use(graphql(() => data({ storage: [storage(DAY, "logs", 30_000_000_000, 0)] })))
    await expect(rows([DAY])).resolves.toEqual([])
    server.resetHandlers()
    server.use(
      graphql(() =>
        data({
          storage: [storage("2026-02-01", "logs", 300_000_000_000, 0), storage(DAY, "logs", 30_000_000_000, 0)],
        }),
      ),
    )
    await expect(rows([DAY])).resolves.toEqual([
      {
        day: DAY,
        provider: "cloudflare",
        sku: "r2_storage",
        scope: "logs",
        usage: 1,
        unit: "gb_month",
        costUsd: cloudflareR2StorageUsdPerGbMonth,
        source: "estimated",
      },
    ])
  })

  test("rounds 1,000,001 Class A requests to one $4.50 unit", async () => {
    server.use(graphql(() => data({ operations: [operation(DAY, "logs", "PutObject", 1_000_001)] })))
    await expect(rows([DAY])).resolves.toEqual([
      {
        day: DAY,
        provider: "cloudflare",
        sku: "r2_class_a",
        scope: "logs",
        usage: 1,
        unit: "requests",
        costUsd: 4.5,
        source: "estimated",
      },
    ])
  })

  test("charges a window day after the free tier is exhausted using month-to-date rounding", async () => {
    server.use(
      graphql(() =>
        data({
          operations: [operation("2026-02-01", "logs", "PutObject", 1_000_000), operation(DAY, "logs", "PutObject", 10)],
        }),
      ),
    )
    await expect(rows([DAY])).resolves.toEqual([
      {
        day: DAY,
        provider: "cloudflare",
        sku: "r2_class_a",
        scope: "logs",
        usage: 10,
        unit: "requests",
        costUsd: 4.5,
        source: "estimated",
      },
    ])
  })

  test("queries each calendar month separately when the window spans two months", async () => {
    const calls: { start: string; end: string }[] = []
    server.use(
      graphql((body) => {
        const start = String(body.variables.start)
        const end = String(body.variables.end)
        calls.push({ start, end })
        const operations = [
          operation("2026-02-01", "logs", "PutObject", 1_000_000),
          operation("2026-02-28", "logs", "PutObject", 20),
          operation("2026-03-01", "logs", "PutObject", 20),
        ].filter((item) => item.dimensions.date >= start && item.dimensions.date <= end)
        return data({ operations })
      }),
    )
    await expect(rows(["2026-02-28", "2026-03-01"])).resolves.toEqual([
      {
        day: "2026-02-28",
        provider: "cloudflare",
        sku: "r2_class_a",
        scope: "logs",
        usage: 20,
        unit: "requests",
        costUsd: 4.5,
        source: "estimated",
      },
    ])
    expect(calls.sort((a, b) => a.start.localeCompare(b.start))).toEqual([
      { start: "2026-02-01", end: "2026-02-28" },
      { start: "2026-03-01", end: "2026-03-01" },
    ])
  })

  test("queries from the 1st of the earliest window month", async () => {
    setSystemTime(new Date("2026-09-26T12:00:00.000Z"))
    const calls: { start: string; end: string }[] = []
    server.use(
      graphql((body) => {
        calls.push({ start: String(body.variables.start), end: String(body.variables.end) })
        return data({})
      }),
    )
    await expect(rows(utcDays(Date.now(), 3))).resolves.toEqual([])
    expect(calls).toEqual([{ start: "2026-09-01", end: "2026-09-26" }])
  })

  test("uses scope account when bucketName is missing", async () => {
    server.use(
      graphql(() =>
        data({
          storage: [{ max: { payloadSize: 330_000_000_000, metadataSize: 0 }, dimensions: { date: DAY } }],
          operations: [{ sum: { requests: 1_000_001 }, dimensions: { date: DAY, actionType: "PutObject" } }],
        }),
      ),
    )
    await expect(rows([DAY])).resolves.toEqual([
      {
        day: DAY,
        provider: "cloudflare",
        sku: "r2_storage",
        scope: "account",
        usage: 1,
        unit: "gb_month",
        costUsd: cloudflareR2StorageUsdPerGbMonth,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "cloudflare",
        sku: "r2_class_a",
        scope: "account",
        usage: 1,
        unit: "requests",
        costUsd: 4.5,
        source: "estimated",
      },
    ])
  })

  test("throws on a GraphQL errors array", async () => {
    server.use(http.post("https://api.cloudflare.com/client/v4/graphql", () => HttpResponse.json({ errors: [{ message: "auth" }] })))
    await expect(rows([DAY])).rejects.toThrow("auth")
  })

  test("throws on an unknown actionType", async () => {
    server.use(graphql(() => data({ operations: [operation(DAY, "logs", "MysteryOp", 1)] })))
    await expect(rows([DAY])).rejects.toThrow("unknown Cloudflare R2 actionType: MysteryOp")
  })

  test("skips malformed items", async () => {
    server.use(
      graphql(() =>
        data({
          storage: [storage(DAY, "logs", 280_000_000_000, 0), { max: { payloadSize: "x" }, dimensions: { date: DAY, bucketName: "bad" } }, null],
          operations: [operation(DAY, "logs", "PutObject", 1_000_001), { sum: { requests: "x" }, dimensions: { date: DAY, bucketName: "logs", actionType: "PutObject" } }, null],
        }),
      ),
    )
    await expect(rows([DAY])).resolves.toEqual([
      {
        day: DAY,
        provider: "cloudflare",
        sku: "r2_class_a",
        scope: "logs",
        usage: 1,
        unit: "requests",
        costUsd: 4.5,
        source: "estimated",
      },
    ])
  })

  test("throws when the JSON body is null", async () => {
    server.use(http.post("https://api.cloudflare.com/client/v4/graphql", () => HttpResponse.json(null)))
    await expect(rows([DAY])).rejects.toThrow("Cloudflare R2 response was missing data")
  })

  test("throws when the API token is missing", async () => {
    delete process.env.CLOUDFLARE_API_TOKEN
    await expect(rows([DAY])).rejects.toThrow("CLOUDFLARE_API_TOKEN is required")
  })
})

function graphql(handler: (body: { query: string; variables: Record<string, unknown> }) => Response) {
  return http.post("https://api.cloudflare.com/client/v4/graphql", async ({ request }) => {
    expect(request.headers.get("Authorization")).toBe("Bearer cf-token")
    const body: unknown = await request.json()
    if (!isRecord(body) || typeof body.query !== "string" || !isRecord(body.variables)) {
      return HttpResponse.json({ errors: [{ message: "bad request" }] }, { status: 400 })
    }
    return handler({ query: body.query, variables: body.variables })
  })
}

function data(fields: { storage?: unknown[]; operations?: unknown[] }) {
  return HttpResponse.json({
    data: {
      viewer: {
        accounts: [
          {
            r2StorageAdaptiveGroups: fields.storage,
            r2OperationsAdaptiveGroups: fields.operations,
          },
        ],
      },
    },
  })
}

function storage(date: string, bucketName: string, payloadSize: number, metadataSize: number) {
  return { max: { payloadSize, metadataSize }, dimensions: { date, bucketName } }
}

function operation(date: string, bucketName: string, actionType: string, requests: number) {
  return { sum: { requests }, dimensions: { date, bucketName, actionType } }
}
