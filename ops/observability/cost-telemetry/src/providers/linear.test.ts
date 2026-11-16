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
import { linearUsdPerSeatMonth } from "../rates"
import { useEnv } from "../test-env"
import { rows } from "./linear"

const LINEAR = "https://api.linear.app/graphql"
// February 2026 has 28 days, March has 31.
const DAYS = ["2026-02-28", "2026-03-01"]

const server = setupServer()
useEnv({ LINEAR_API_KEY: "lin-key" })

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" })
})
afterEach(() => {
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

describe("linear rows", () => {
  test("derives each day's cost from the billed seats and the committed seat price", async () => {
    let query = ""
    server.use(
      http.post(LINEAR, async ({ request }) => {
        expect(request.headers.get("Authorization")).toBe("lin-key")
        const body: unknown = await request.json()
        query =
          isRecord(body) && typeof body.query === "string" ? body.query : ""
        return subscription({
          type: "business_yearly",
          seats: 7,
          seatsMinimum: null,
          seatsMaximum: null,
        })
      }),
    )
    const price = linearUsdPerSeatMonth.business_yearly ?? Number.NaN
    await expect(rows(DAYS)).resolves.toEqual([
      {
        day: "2026-02-28",
        provider: "linear",
        sku: "business_yearly",
        scope: "workspace",
        usage: 7,
        unit: "seats",
        costUsd: (7 * price) / 28,
        source: "derived",
      },
      {
        day: "2026-03-01",
        provider: "linear",
        sku: "business_yearly",
        scope: "workspace",
        usage: 7,
        unit: "seats",
        costUsd: (7 * price) / 31,
        source: "derived",
      },
    ])
    expect(query).toContain(
      "subscription { type seats seatsMinimum seatsMaximum }",
    )
  })

  test("bills the seat minimum and the seat maximum, at the price of the billing variant", async () => {
    const monthly = linearUsdPerSeatMonth.basic_monthly ?? Number.NaN
    const yearly = linearUsdPerSeatMonth.basic_yearly ?? Number.NaN
    expect(monthly).toBeGreaterThan(yearly)
    server.use(
      http.post(LINEAR, () =>
        subscription({
          type: "basic_monthly_12",
          seats: 2,
          seatsMinimum: 3,
          seatsMaximum: null,
        }),
      ),
    )
    expect((await rows(["2026-03-01"]))[0]).toMatchObject({
      sku: "basic_monthly_12",
      usage: 3,
      costUsd: (3 * monthly) / 31,
    })
    server.resetHandlers()
    server.use(
      http.post(LINEAR, () =>
        subscription({
          type: "basic_yearly",
          seats: 12,
          seatsMinimum: null,
          seatsMaximum: 10,
        }),
      ),
    )
    expect((await rows(["2026-03-01"]))[0]).toMatchObject({
      usage: 10,
      costUsd: (10 * yearly) / 31,
    })
  })

  test("gives no rows without a paid subscription", async () => {
    server.use(
      http.post(LINEAR, () =>
        HttpResponse.json({ data: { organization: { subscription: null } } }),
      ),
    )
    await expect(rows(DAYS)).resolves.toEqual([])
  })

  test("throws on a subscription type without a committed price", async () => {
    server.use(
      http.post(LINEAR, () =>
        subscription({
          type: "enterprise_yearly",
          seats: 7,
          seatsMinimum: null,
          seatsMaximum: null,
        }),
      ),
    )
    await expect(rows(DAYS)).rejects.toThrow(
      "no committed seat price for Linear subscription type enterprise_yearly",
    )
    // A type without its billing variant does not say which price applies.
    server.resetHandlers()
    server.use(
      http.post(LINEAR, () =>
        subscription({
          type: "basic",
          seats: 7,
          seatsMinimum: null,
          seatsMaximum: null,
        }),
      ),
    )
    await expect(rows(DAYS)).rejects.toThrow(
      "no committed seat price for Linear subscription type basic",
    )
  })

  test("throws on GraphQL errors, a missing organization and missing seats", async () => {
    server.use(
      http.post(LINEAR, () =>
        HttpResponse.json({ errors: [{ message: "Authentication required" }] }),
      ),
    )
    await expect(rows(DAYS)).rejects.toThrow("Authentication required")
    server.resetHandlers()
    server.use(http.post(LINEAR, () => HttpResponse.json({ data: {} })))
    await expect(rows(DAYS)).rejects.toThrow(
      "Linear response was missing organization",
    )
    server.resetHandlers()
    server.use(http.post(LINEAR, () => subscription({ type: "basic_yearly" })))
    await expect(rows(DAYS)).rejects.toThrow(
      "Linear response was missing subscription.seats",
    )
  })

  test("throws when the API key is missing", async () => {
    delete process.env.LINEAR_API_KEY
    await expect(rows(DAYS)).rejects.toThrow("LINEAR_API_KEY is required")
  })
})

function subscription(fields: Record<string, unknown>) {
  return HttpResponse.json({ data: { organization: { subscription: fields } } })
}
