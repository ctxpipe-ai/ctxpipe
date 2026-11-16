import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { useEnv } from "../test-env"
import { rows } from "./aws"

const DAYS = ["2026-09-24", "2026-09-25", "2026-09-26"]
const FETCH_AT = new Date("2026-09-26T12:17:00.000Z")
const CE = /https:\/\/ce\.us-east-1\.amazonaws\.com\/?$/
const STS = /https:\/\/sts\.us-east-1\.amazonaws\.com\/?$/

const server = setupServer()
// The task role, as the default credential chain reads it (the env provider comes first in that chain).
useEnv({
  AWS_ACCESS_KEY_ID: "AKIATASKROLE",
  AWS_SECRET_ACCESS_KEY: "task-secret",
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
  test("assumes the Cost Explorer role with the task role and signs Cost Explorer with the assumed credentials", async () => {
    setSystemTime(FETCH_AT)
    const assumed: { form: URLSearchParams; authorization: string | null }[] = []
    const signed: { authorization: string | null; token: string | null }[] = []
    server.use(
      http.post(STS, async ({ request }) => {
        assumed.push({ form: new URLSearchParams(await request.text()), authorization: request.headers.get("authorization") })
        return assumeRoleXml()
      }),
      http.post(CE, ({ request }) => {
        signed.push({ authorization: request.headers.get("authorization"), token: request.headers.get("x-amz-security-token") })
        return ceJson({ ResultsByTime: [] })
      }),
    )
    await expect(rows(DAYS)).resolves.toEqual([])
    expect(assumed).toHaveLength(1)
    expect(assumed[0]?.form.get("Action")).toBe("AssumeRole")
    expect(assumed[0]?.form.get("RoleArn")).toBe("arn:aws:iam::007664619564:role/ctxpipe-cost-explorer-read")
    expect(assumed[0]?.form.get("RoleSessionName")).toBe("ctxpipe-cost-telemetry")
    expect(assumed[0]?.authorization).toContain("Credential=AKIATASKROLE/")
    expect(signed).toEqual([{ authorization: expect.stringContaining("Credential=ASIAASSUMED/"), token: "assumed-token" }])
  })

  test("groups every account by LINKED_ACCOUNT and SERVICE and names each account", async () => {
    setSystemTime(FETCH_AT)
    const bodies: unknown[] = []
    server.use(
      http.post(STS, () => assumeRoleXml()),
      http.post(CE, async ({ request }) => {
        expect(request.headers.get("x-amz-target")).toBe("AWSInsightsIndexService.GetCostAndUsage")
        bodies.push(await request.json())
        return ceJson({
          ResultsByTime: [
            result("2026-09-24", [
              group("213102790567", "Amazon Elastic Container Service", "1.25", "24", "Hrs"),
              group("134416647419", "AWS Lambda", "-0.25", "0", "N/A"),
              group("999999999999", "Amazon Simple Storage Service", "0.02", "12.5", "GB-Month"),
            ]),
            result("2026-09-25", [group("007664619564", "AWS Cost Explorer", "0.01", "1", "Requests")]),
          ],
        })
      }),
    )
    await expect(rows(DAYS)).resolves.toEqual([
      {
        day: "2026-09-24",
        provider: "aws",
        sku: "Amazon Elastic Container Service",
        scope: "213102790567/Amazon Elastic Container Service",
        usage: 24,
        unit: "Hrs",
        costUsd: 1.25,
        source: "reported",
        account: "production",
      },
      {
        day: "2026-09-24",
        provider: "aws",
        sku: "AWS Lambda",
        scope: "134416647419/AWS Lambda",
        usage: 0,
        unit: "",
        costUsd: -0.25,
        source: "reported",
        account: "factory",
      },
      {
        day: "2026-09-24",
        provider: "aws",
        sku: "Amazon Simple Storage Service",
        scope: "999999999999/Amazon Simple Storage Service",
        usage: 12.5,
        unit: "GB-Month",
        costUsd: 0.02,
        source: "reported",
        account: "999999999999",
      },
      {
        day: "2026-09-25",
        provider: "aws",
        sku: "AWS Cost Explorer",
        scope: "007664619564/AWS Cost Explorer",
        usage: 1,
        unit: "Requests",
        costUsd: 0.01,
        source: "reported",
        account: "management",
      },
    ])
    expect(bodies).toEqual([
      {
        TimePeriod: { Start: "2026-09-24", End: "2026-09-27" },
        Granularity: "DAILY",
        Metrics: ["NetUnblendedCost", "UnblendedCost", "UsageQuantity"],
        GroupBy: [
          { Type: "DIMENSION", Key: "LINKED_ACCOUNT" },
          { Type: "DIMENSION", Key: "SERVICE" },
        ],
      },
    ])
  })

  test("returns no rows outside the 12:17 UTC Cost Explorer slot", async () => {
    setSystemTime(new Date("2026-09-26T13:17:00.000Z"))
    server.use(
      http.post(STS, () => HttpResponse.text("should not assume the role", { status: 500 })),
      http.post(CE, () => HttpResponse.text("should not call Cost Explorer", { status: 500 })),
    )
    await expect(rows(DAYS)).resolves.toEqual([])
  })

  test("pages through NextPageToken and falls back to UnblendedCost", async () => {
    setSystemTime(FETCH_AT)
    const tokens: Array<string | undefined> = []
    server.use(
      http.post(STS, () => assumeRoleXml()),
      http.post(CE, async ({ request }) => {
        const body = (await request.json()) as { NextPageToken?: string }
        tokens.push(body.NextPageToken)
        if (!body.NextPageToken) {
          return ceJson({
            NextPageToken: "page-2",
            ResultsByTime: [
              result("2026-09-26", [
                {
                  Keys: ["573018602187", "AmazonCloudWatch"],
                  Metrics: {
                    UnblendedCost: { Amount: "0.12", Unit: "USD" },
                    UsageQuantity: { Amount: "1000", Unit: "Requests" },
                  },
                },
              ]),
            ],
          })
        }
        return ceJson({
          ResultsByTime: [result("2026-09-26", [group("787752212265", "AWS Glue", "1.5", "3", "DPU-Hour")])],
        })
      }),
    )
    await expect(rows(DAYS)).resolves.toEqual([
      {
        day: "2026-09-26",
        provider: "aws",
        sku: "AmazonCloudWatch",
        scope: "573018602187/AmazonCloudWatch",
        usage: 1000,
        unit: "Requests",
        costUsd: 0.12,
        source: "reported",
        account: "preview",
      },
      {
        day: "2026-09-26",
        provider: "aws",
        sku: "AWS Glue",
        scope: "787752212265/AWS Glue",
        usage: 3,
        unit: "DPU-Hour",
        costUsd: 1.5,
        source: "reported",
        account: "selfhost-sandbox",
      },
    ])
    expect(tokens).toEqual([undefined, "page-2"])
  })

  test("throws when the role cannot be assumed, on an error response and on a group with no cost metric", async () => {
    setSystemTime(FETCH_AT)
    server.use(
      http.post(STS, () =>
        HttpResponse.xml(
          `<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>not authorized to perform sts:AssumeRole</Message></Error></ErrorResponse>`,
          { status: 403 },
        ),
      ),
      http.post(CE, () => HttpResponse.text("should not call Cost Explorer", { status: 500 })),
    )
    await expect(rows(DAYS)).rejects.toThrow(/sts:AssumeRole/)

    server.resetHandlers()
    server.use(
      http.post(STS, () => assumeRoleXml()),
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
      http.post(STS, () => assumeRoleXml()),
      http.post(CE, () =>
        ceJson({
          ResultsByTime: [
            result("2026-09-24", [
              {
                Keys: ["213102790567", "Amazon Simple Storage Service"],
                Metrics: { UsageQuantity: { Amount: "9", Unit: "Requests" } },
              },
            ]),
          ],
        }),
      ),
    )
    await expect(rows(DAYS)).rejects.toThrow("missing NetUnblendedCost and UnblendedCost")
  })
})

function assumeRoleXml() {
  return HttpResponse.xml(`<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleResult>
    <Credentials>
      <AccessKeyId>ASIAASSUMED</AccessKeyId>
      <SecretAccessKey>assumed-secret</SecretAccessKey>
      <SessionToken>assumed-token</SessionToken>
      <Expiration>2026-09-26T13:17:00Z</Expiration>
    </Credentials>
    <AssumedRoleUser>
      <AssumedRoleId>AROAEXAMPLE:ctxpipe-cost-telemetry</AssumedRoleId>
      <Arn>arn:aws:sts::007664619564:assumed-role/ctxpipe-cost-explorer-read/ctxpipe-cost-telemetry</Arn>
    </AssumedRoleUser>
  </AssumeRoleResult>
  <ResponseMetadata><RequestId>example</RequestId></ResponseMetadata>
</AssumeRoleResponse>`)
}

function group(account: string, service: string, cost: string, usage: string, unit: string) {
  return {
    Keys: [account, service],
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
