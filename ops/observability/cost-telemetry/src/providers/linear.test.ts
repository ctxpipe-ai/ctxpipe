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
const TOKEN = "https://api.linear.app/oauth/token"
// February 2026 has 28 days, March has 31.
const DAYS = ["2026-02-28", "2026-03-01"]

const server = setupServer(appToken())
useEnv({ LINEAR_CLIENT_ID: "lin-id", LINEAR_CLIENT_SECRET: "lin-secret" })

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
        expect(request.headers.get("Authorization")).toBe("Bearer app-token")
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

  test("asks for the app token with the client credentials and the fixed scopes of the app", async () => {
    let grant: URLSearchParams | undefined
    let authorization = null as string | null
    server.use(
      http.post(TOKEN, async ({ request }) => {
        authorization = request.headers.get("Authorization")
        grant = new URLSearchParams(await request.text())
        return HttpResponse.json({ access_token: "app-token" })
      }),
      http.post(LINEAR, () => subscription({ type: "basic_yearly", seats: 1 })),
    )
    await rows(DAYS)
    expect(authorization).toBe(`Basic ${btoa("lin-id:lin-secret")}`)
    expect(grant?.get("grant_type")).toBe("client_credentials")
    // Other scopes than the agent hosts' revoke all tokens of the app.
    expect(grant?.get("scope")).toBe(
      "read,write,issues:create,comments:create,app:assignable,app:mentionable",
    )
  })

  test("throws when the token request fails or gives no token", async () => {
    server.use(
      http.post(TOKEN, () =>
        HttpResponse.json({ error: "invalid_client" }, { status: 401 }),
      ),
    )
    await expect(rows(DAYS)).rejects.toThrow("Linear token HTTP 401")
    server.resetHandlers()
    server.use(http.post(TOKEN, () => HttpResponse.json({})))
    await expect(rows(DAYS)).rejects.toThrow(
      "Linear token response was missing access_token",
    )
  })

  test("throws when a client credential is missing", async () => {
    delete process.env.LINEAR_CLIENT_SECRET
    await expect(rows(DAYS)).rejects.toThrow("LINEAR_CLIENT_SECRET is required")
  })
})

function appToken() {
  return http.post(TOKEN, () =>
    HttpResponse.json({ access_token: "app-token" }),
  )
}

function subscription(fields: Record<string, unknown>) {
  return HttpResponse.json({ data: { organization: { subscription: fields } } })
}
