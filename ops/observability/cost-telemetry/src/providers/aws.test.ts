import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { useEnv } from "../test-env"
import { rows } from "./aws"

const DAYS = ["2026-09-24", "2026-09-25", "2026-09-26"]
const FETCH_AT = new Date("2026-09-26T12:17:00.000Z")
const ACCOUNT = "007664619564"
const CE = /https:\/\/ce\.us-east-1\.amazonaws\.com\/?$/

const server = setupServer()
useEnv({
  AWS_ACCESS_KEY_ID: "AKIATEST",
  AWS_SECRET_ACCESS_KEY: "test-secret",
})

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

describe("aws rows", () => {
  test("maps Cost Explorer groups and sends DAILY GetCostAndUsage for the sandbox account", async () => {
    setSystemTime(FETCH_AT)
    const bodies: unknown[] = []
    server.use(
      http.post(CE, async ({ request }) => {
        expect(request.headers.get("x-amz-target")).toBe("AWSInsightsIndexService.GetCostAndUsage")
        bodies.push(await request.json())
        return ceJson({
          ResultsByTime: [
            result("2026-09-24", [
              group("Amazon Elastic Compute Cloud - Compute", "BoxUsage:t3.micro", "0.0104", "24", "Hrs"),
              group("AWS Lambda", "Lambda-GB-Second", "-0.25", "0", "N/A"),
              group("Amazon Simple Storage Service", "TimedStorage-ByteHrs", "0.02", "12.5", "GB-Month"),
              group("Amazon Simple Storage Service", "TimedStorage-ByteHrs", "0.01", "2.5", "GB-Month"),
            ]),
            result("2026-09-25", [group("Amazon Simple Storage Service", "Requests-Tier1", "0", "0", "N/A")]),
          ],
        })
      }),
    )
    await expect(rows(DAYS)).resolves.toEqual([
      {
        day: "2026-09-24",
        provider: "aws",
        sku: "BoxUsage:t3.micro",
        scope: `${ACCOUNT}/Amazon Elastic Compute Cloud - Compute`,
        usage: 24,
        unit: "Hrs",
        costUsd: 0.0104,
        source: "reported",
      },
      {
        day: "2026-09-24",
        provider: "aws",
        sku: "Lambda-GB-Second",
        scope: `${ACCOUNT}/AWS Lambda`,
        usage: 0,
        unit: "",
        costUsd: -0.25,
        source: "reported",
      },
      {
        day: "2026-09-24",
        provider: "aws",
        sku: "TimedStorage-ByteHrs",
        scope: `${ACCOUNT}/Amazon Simple Storage Service`,
        usage: 15,
        unit: "GB-Month",
        costUsd: 0.03,
        source: "reported",
      },
      {
        day: "2026-09-25",
        provider: "aws",
        sku: "Requests-Tier1",
        scope: `${ACCOUNT}/Amazon Simple Storage Service`,
        usage: 0,
        unit: "",
        costUsd: 0,
        source: "reported",
      },
    ])
    expect(bodies).toEqual([
      {
        TimePeriod: { Start: "2026-09-24", End: "2026-09-27" },
        Granularity: "DAILY",
        Metrics: ["NetUnblendedCost", "UnblendedCost", "UsageQuantity"],
        GroupBy: [
          { Type: "DIMENSION", Key: "SERVICE" },
          { Type: "DIMENSION", Key: "USAGE_TYPE" },
        ],
        Filter: { Dimensions: { Key: "LINKED_ACCOUNT", Values: [ACCOUNT] } },
      },
    ])
  })

  test("returns no rows outside the 12:17 UTC Cost Explorer slot", async () => {
    setSystemTime(new Date("2026-09-26T13:17:00.000Z"))
    delete process.env.AWS_ACCESS_KEY_ID
    server.use(http.post(CE, () => HttpResponse.text("should not call Cost Explorer", { status: 500 })))
    await expect(rows(DAYS)).resolves.toEqual([])
  })

  test("pages through NextPageToken and falls back to UnblendedCost", async () => {
    setSystemTime(FETCH_AT)
    const tokens: Array<string | undefined> = []
    server.use(
      http.post(CE, async ({ request }) => {
        const body = (await request.json()) as { NextPageToken?: string }
        tokens.push(body.NextPageToken)
        if (!body.NextPageToken) {
          return ceJson({
            NextPageToken: "page-2",
            ResultsByTime: [
              result("2026-09-26", [
                {
                  Keys: ["AmazonCloudWatch", "CW:Requests"],
                  Metrics: {
                    UnblendedCost: { Amount: "0.12", Unit: "USD" },
                    UsageQuantity: { Amount: "1000", Unit: "Requests" },
                  },
                },
              ]),
            ],
          })
        }
        expect(body.NextPageToken).toBe("page-2")
        return ceJson({
          ResultsByTime: [result("2026-09-26", [group("AWS Glue", "Crawler-DPU-Hour", "1.5", "3", "DPU-Hour")])],
        })
      }),
    )
    await expect(rows(DAYS)).resolves.toEqual([
      {
        day: "2026-09-26",
        provider: "aws",
        sku: "CW:Requests",
        scope: `${ACCOUNT}/AmazonCloudWatch`,
        usage: 1000,
        unit: "Requests",
        costUsd: 0.12,
        source: "reported",
      },
      {
        day: "2026-09-26",
        provider: "aws",
        sku: "Crawler-DPU-Hour",
        scope: `${ACCOUNT}/AWS Glue`,
        usage: 3,
        unit: "DPU-Hour",
        costUsd: 1.5,
        source: "reported",
      },
    ])
    expect(tokens).toEqual([undefined, "page-2"])
  })

  test("throws on an error response and on a group with no cost metric", async () => {
    setSystemTime(FETCH_AT)
    server.use(
      http.post(CE, () =>
        HttpResponse.json(
          { __type: "AccessDeniedException", Message: "User is not authorized" },
          { status: 403, headers: { "Content-Type": "application/x-amz-json-1.1" } },
        ),
      ),
    )
    await expect(rows(DAYS)).rejects.toThrow(/AccessDenied|not authorized|403/i)

    server.resetHandlers()
    server.use(
      http.post(CE, () =>
        ceJson({
          ResultsByTime: [
            result("2026-09-24", [
              {
                Keys: ["Amazon Simple Storage Service", "Requests-Tier2"],
                Metrics: { UsageQuantity: { Amount: "9", Unit: "Requests" } },
              },
            ]),
          ],
        }),
      ),
    )
    await expect(rows(DAYS)).rejects.toThrow("missing NetUnblendedCost and UnblendedCost")
  })

  test("throws when the access key is missing at the fetch hour", async () => {
    setSystemTime(FETCH_AT)
    delete process.env.AWS_ACCESS_KEY_ID
    await expect(rows(DAYS)).rejects.toThrow("AWS_ACCESS_KEY_ID is required")
  })
})

function group(service: string, usageType: string, cost: string, usage: string, unit: string) {
  return {
    Keys: [service, usageType],
    Metrics: {
      NetUnblendedCost: { Amount: cost, Unit: "USD" },
      UsageQuantity: { Amount: usage, Unit: unit },
    },
  }
}

function result(start: string, groups: unknown[]) {
  return {
    TimePeriod: { Start: start, End: exclusiveNext(start) },
    Estimated: true,
    Groups: groups,
    Total: {},
  }
}

function exclusiveNext(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)
}

function ceJson(body: Record<string, unknown>) {
  return HttpResponse.json(body, { headers: { "Content-Type": "application/x-amz-json-1.1" } })
}
