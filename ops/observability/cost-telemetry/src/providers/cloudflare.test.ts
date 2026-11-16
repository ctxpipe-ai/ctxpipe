import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"

import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"

import { isRecord } from "../http"
import { useEnv } from "../test-env"
import { rows } from "./cloudflare"

const DAYS = ["2026-02-03", "2026-02-04"]
const ACCOUNT = "cf-account"
const HISTORY = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/billing/history`
const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql"

const server = setupServer()
useEnv({ CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: ACCOUNT })

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" })
})
afterEach(() => {
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

describe("cloudflare rows", () => {
  test("reports one row per charge of the window from every page of the billing history", async () => {
    const pages: (string | null)[] = []
    server.use(
      http.get(HISTORY, ({ request }) => {
        expect(request.headers.get("Authorization")).toBe("Bearer cf-token")
        const page = new URL(request.url).searchParams.get("page")
        pages.push(page)
        const items =
          page === "1"
            ? [
                charge("ch-1", "2026-02-04T08:00:00Z", 25, "Workers Paid"),
                charge("ch-2", "2026-02-04T09:00:00Z", 5, "Workers Paid"),
                {
                  ...charge("pay-1", "2026-02-04T10:00:00Z", 30, "Payment"),
                  type: "payment",
                },
              ]
            : [
                charge("ch-3", "2026-02-03T00:30:00Z", 1.5, ""),
                charge("ch-old", "2026-01-01T00:00:00Z", 99, "Pro plan"),
              ]
        return HttpResponse.json(
          history(items, { page: Number(page), per_page: 3, total_count: 5 }),
        )
      }),
      graphql(() => data({})),
    )
    await expect(rows(DAYS)).resolves.toEqual([
      {
        day: "2026-02-04",
        provider: "cloudflare",
        sku: "Workers Paid",
        scope: "ch-1",
        usage: 1,
        unit: "charge",
        costUsd: 25,
        source: "reported",
      },
      {
        day: "2026-02-04",
        provider: "cloudflare",
        sku: "Workers Paid",
        scope: "ch-2",
        usage: 1,
        unit: "charge",
        costUsd: 5,
        source: "reported",
      },
      {
        day: "2026-02-03",
        provider: "cloudflare",
        sku: "subscription",
        scope: "ch-3",
        usage: 1,
        unit: "charge",
        costUsd: 1.5,
        source: "reported",
      },
    ])
    expect(pages).toEqual(["1", "2"])
  })

  test("stops at an empty page when the history has no result_info", async () => {
    const pages: (string | null)[] = []
    server.use(
      http.get(HISTORY, ({ request }) => {
        const page = new URL(request.url).searchParams.get("page")
        pages.push(page)
        return HttpResponse.json({
          success: true,
          result:
            page === "1"
              ? [charge("ch-1", "2026-02-04T08:00:00Z", 2, "R2")]
              : [],
        })
      }),
      graphql(() => data({})),
    )
    await expect(rows(DAYS)).resolves.toEqual([
      {
        day: "2026-02-04",
        provider: "cloudflare",
        sku: "R2",
        scope: "ch-1",
        usage: 1,
        unit: "charge",
        costUsd: 2,
        source: "reported",
      },
    ])
    expect(pages).toEqual(["1", "2"])
  })

  test("reports R2 usage with no cost so a charge is not counted twice", async () => {
    let variables: Record<string, unknown> = {}
    server.use(
      http.get(HISTORY, () =>
        HttpResponse.json(
          history([], { page: 1, per_page: 20, total_count: 0 }),
        ),
      ),
      graphql((body) => {
        variables = body.variables
        return data({
          storage: [
            storage("2026-02-04", "logs", 30_000_000_000, 0),
            storage("2026-02-04", "logs", 0, 0),
            {
              max: { payloadSize: 3_000_000_000, metadataSize: 0 },
              dimensions: { date: "2026-02-03" },
            },
          ],
          operations: [
            operation("2026-02-04", "logs", "PutObject", 300),
            operation("2026-02-04", "logs", "ListObjects", 200),
            operation("2026-02-04", "logs", "GetObject", 10),
            operation("2026-02-04", "logs", "DeleteObject", 50),
          ],
        })
      }),
    )
    await expect(rows(DAYS)).resolves.toEqual([
      {
        day: "2026-02-04",
        provider: "cloudflare",
        sku: "r2_storage",
        scope: "logs",
        usage: 1,
        unit: "gb_month",
        costUsd: 0,
        source: "reported",
      },
      {
        day: "2026-02-03",
        provider: "cloudflare",
        sku: "r2_storage",
        scope: "account",
        usage: 0.1,
        unit: "gb_month",
        costUsd: 0,
        source: "reported",
      },
      {
        day: "2026-02-04",
        provider: "cloudflare",
        sku: "r2_class_a",
        scope: "logs",
        usage: 500,
        unit: "requests",
        costUsd: 0,
        source: "reported",
      },
      {
        day: "2026-02-04",
        provider: "cloudflare",
        sku: "r2_class_b",
        scope: "logs",
        usage: 10,
        unit: "requests",
        costUsd: 0,
        source: "reported",
      },
    ])
    expect(variables).toEqual({
      accountTag: ACCOUNT,
      start: "2026-02-03",
      end: "2026-02-04",
    })
  })

  test("throws on a charge in another currency", async () => {
    server.use(
      http.get(HISTORY, () =>
        HttpResponse.json(
          history([
            {
              ...charge("ch-1", "2026-02-04T08:00:00Z", 3, "Pro"),
              currency: "EUR",
            },
          ]),
        ),
      ),
      graphql(() => data({})),
    )
    await expect(rows(DAYS)).rejects.toThrow(
      "Cloudflare charge ch-1 is in EUR, not USD",
    )
  })

  test("throws on a billing history error and on a response without result", async () => {
    server.use(
      http.get(HISTORY, () =>
        HttpResponse.json(
          {
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
          },
          { status: 403 },
        ),
      ),
      graphql(() => data({})),
    )
    await expect(rows(DAYS)).rejects.toThrow(
      "Cloudflare billing history HTTP 403",
    )
    server.resetHandlers()
    server.use(
      http.get(HISTORY, () => HttpResponse.json({ success: true })),
      graphql(() => data({})),
    )
    await expect(rows(DAYS)).rejects.toThrow(
      "Cloudflare billing history response was missing result",
    )
  })

  test("throws on a GraphQL errors array, an unknown actionType and a null body", async () => {
    server.use(
      http.get(HISTORY, () => HttpResponse.json(history([]))),
      http.post(GRAPHQL, () =>
        HttpResponse.json({ errors: [{ message: "auth" }] }),
      ),
    )
    await expect(rows(DAYS)).rejects.toThrow("auth")
    server.resetHandlers()
    server.use(
      http.get(HISTORY, () => HttpResponse.json(history([]))),
      graphql(() =>
        data({ operations: [operation("2026-02-04", "logs", "MysteryOp", 1)] }),
      ),
    )
    await expect(rows(DAYS)).rejects.toThrow(
      "unknown Cloudflare R2 actionType: MysteryOp",
    )
    server.resetHandlers()
    server.use(
      http.get(HISTORY, () => HttpResponse.json(history([]))),
      http.post(GRAPHQL, () => HttpResponse.json(null)),
    )
    await expect(rows(DAYS)).rejects.toThrow(
      "Cloudflare R2 response was missing data",
    )
  })

  test("throws when the API token is missing", async () => {
    delete process.env.CLOUDFLARE_API_TOKEN
    await expect(rows(DAYS)).rejects.toThrow("CLOUDFLARE_API_TOKEN is required")
  })

  test("throws when the account id is missing", async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID
    await expect(rows(DAYS)).rejects.toThrow(
      "CLOUDFLARE_ACCOUNT_ID is required",
    )
  })
})

function charge(
  id: string,
  occurredAt: string,
  amount: number,
  description: string,
) {
  return {
    id,
    type: "charge",
    action: "subscription",
    amount,
    currency: "USD",
    description,
    occurred_at: occurredAt,
  }
}

function history(result: unknown[], resultInfo?: Record<string, number>) {
  return {
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo && { result_info: { count: result.length, ...resultInfo } }),
  }
}

function graphql(
  handler: (body: {
    query: string
    variables: Record<string, unknown>
  }) => Response,
) {
  return http.post(GRAPHQL, async ({ request }) => {
    expect(request.headers.get("Authorization")).toBe("Bearer cf-token")
    const body: unknown = await request.json()
    if (
      !isRecord(body) ||
      typeof body.query !== "string" ||
      !isRecord(body.variables)
    ) {
      return HttpResponse.json(
        { errors: [{ message: "bad request" }] },
        { status: 400 },
      )
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

function storage(
  date: string,
  bucketName: string,
  payloadSize: number,
  metadataSize: number,
) {
  return {
    max: { payloadSize, metadataSize },
    dimensions: { date, bucketName },
  }
}

function operation(
  date: string,
  bucketName: string,
  actionType: string,
  requests: number,
) {
  return { sum: { requests }, dimensions: { date, bucketName, actionType } }
}
