import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test"

import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"

import type { CostRow } from "../rows"
import { useEnv } from "../test-env"
import { due, rows } from "./aws"

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
    const assumed: { form: URLSearchParams; authorization: string | null }[] =
      []
    const signed: { authorization: string | null; token: string | null }[] = []
    server.use(
      http.post(STS, async ({ request }) => {
        assumed.push({
          form: new URLSearchParams(await request.text()),
          authorization: request.headers.get("authorization"),
        })
        return assumeRoleXml()
      }),
      http.post(CE, ({ request }) => {
        signed.push({
          authorization: request.headers.get("authorization"),
          token: request.headers.get("x-amz-security-token"),
        })
        return ceJson({ ResultsByTime: [] })
      }),
    )
    await expect(rows(DAYS)).resolves.toEqual([])
    expect(assumed).toHaveLength(1)
    expect(assumed[0]?.form.get("Action")).toBe("AssumeRole")
    expect(assumed[0]?.form.get("RoleArn")).toBe(
      "arn:aws:iam::007664619564:role/ctxpipe-cost-explorer-read",
    )
    expect(assumed[0]?.form.get("RoleSessionName")).toBe(
      "ctxpipe-cost-telemetry",
    )
    expect(assumed[0]?.authorization).toContain("Credential=AKIATASKROLE/")
    // Two queries (usage, and the other record types) with one assumed role.
    const assumedCall = {
      authorization: expect.stringContaining("Credential=ASIAASSUMED/"),
      token: "assumed-token",
    }
    expect(signed).toEqual([assumedCall, assumedCall])
  })

  test("reports gross usage by account and service, and every other record type except Credit by account", async () => {
    setSystemTime(FETCH_AT)
    const bodies: unknown[] = []
    server.use(
      http.post(STS, () => assumeRoleXml()),
      http.post(CE, async ({ request }) => {
        expect(request.headers.get("x-amz-target")).toBe(
          "AWSInsightsIndexService.GetCostAndUsage",
        )
        const body = (await request.json()) as CeBody
        bodies.push(body)
        if (groupKey(body) === "SERVICE") {
          return ceJson({
            ResultsByTime: [
              result("2026-09-24", [
                group(
                  "213102790567",
                  "Amazon Elastic Container Service",
                  "1.25",
                ),
                group("999999999999", "Amazon Simple Storage Service", "0.02"),
              ]),
              result("2026-09-25", [
                group("007664619564", "AWS Cost Explorer", "0.01"),
              ]),
            ],
          })
        }
        return ceJson({
          ResultsByTime: [
            result("2026-09-24", [
              group("213102790567", "Tax", "0.13"),
              group("134416647419", "Refund", "-0.25"),
            ]),
            result("2026-09-25", [group("007664619564", "Support", "29")]),
          ],
        })
      }),
    )
    await expect(rows(DAYS)).resolves.toEqual([
      awsRow(
        "2026-09-24",
        "213102790567",
        "Amazon Elastic Container Service",
        1.25,
        "production",
      ),
      awsRow(
        "2026-09-24",
        "999999999999",
        "Amazon Simple Storage Service",
        0.02,
        "999999999999",
      ),
      awsRow(
        "2026-09-25",
        "007664619564",
        "AWS Cost Explorer",
        0.01,
        "management",
      ),
      awsRow("2026-09-24", "213102790567", "Tax", 0.13, "production"),
      awsRow("2026-09-24", "134416647419", "Refund", -0.25, "factory"),
      awsRow("2026-09-25", "007664619564", "Support", 29, "management"),
    ])
    const request = {
      TimePeriod: { Start: "2026-09-24", End: "2026-09-27" },
      Granularity: "DAILY",
      Metrics: ["NetUnblendedCost", "UnblendedCost"],
    }
    expect(bodies).toEqual([
      {
        ...request,
        Filter: { Dimensions: { Key: "RECORD_TYPE", Values: ["Usage"] } },
        GroupBy: [
          { Type: "DIMENSION", Key: "LINKED_ACCOUNT" },
          { Type: "DIMENSION", Key: "SERVICE" },
        ],
      },
      {
        ...request,
        Filter: {
          Not: {
            Dimensions: { Key: "RECORD_TYPE", Values: ["Usage", "Credit"] },
          },
        },
        GroupBy: [
          { Type: "DIMENSION", Key: "LINKED_ACCOUNT" },
          { Type: "DIMENSION", Key: "RECORD_TYPE" },
        ],
      },
    ])
  })

  test("is due only in the 12:17 UTC Cost Explorer slot", () => {
    expect(due(FETCH_AT)).toBe(true)
    expect(due(new Date("2026-09-26T13:17:00.000Z"))).toBe(false)
    expect(due(new Date("2026-09-26T11:17:00.000Z"))).toBe(false)
  })

  test("pages through NextPageToken of each query and falls back to UnblendedCost", async () => {
    setSystemTime(FETCH_AT)
    const pages: Array<[string | undefined, string | undefined]> = []
    server.use(
      http.post(STS, () => assumeRoleXml()),
      http.post(CE, async ({ request }) => {
        const body = (await request.json()) as CeBody
        const key = groupKey(body)
        pages.push([key, body.NextPageToken])
        if (!body.NextPageToken) {
          return ceJson({
            NextPageToken: `${key}-page-2`,
            ResultsByTime: [
              result("2026-09-26", [
                {
                  Keys: [
                    "573018602187",
                    key === "SERVICE" ? "AmazonCloudWatch" : "Tax",
                  ],
                  Metrics: { UnblendedCost: { Amount: "0.12", Unit: "USD" } },
                },
              ]),
            ],
          })
        }
        return ceJson({
          ResultsByTime: [
            result("2026-09-26", [
              group(
                "787752212265",
                key === "SERVICE" ? "AWS Glue" : "Fee",
                "1.5",
              ),
            ]),
          ],
        })
      }),
    )
    await expect(rows(DAYS)).resolves.toEqual([
      awsRow("2026-09-26", "573018602187", "AmazonCloudWatch", 0.12, "preview"),
      awsRow("2026-09-26", "787752212265", "AWS Glue", 1.5, "selfhost-sandbox"),
      awsRow("2026-09-26", "573018602187", "Tax", 0.12, "preview"),
      awsRow("2026-09-26", "787752212265", "Fee", 1.5, "selfhost-sandbox"),
    ])
    expect(pages).toEqual([
      ["SERVICE", undefined],
      ["SERVICE", "SERVICE-page-2"],
      ["RECORD_TYPE", undefined],
      ["RECORD_TYPE", "RECORD_TYPE-page-2"],
    ])
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
      http.post(CE, () =>
        HttpResponse.text("should not call Cost Explorer", { status: 500 }),
      ),
    )
    await expect(rows(DAYS)).rejects.toThrow(/sts:AssumeRole/)

    server.resetHandlers()
    server.use(
      http.post(STS, () => assumeRoleXml()),
      http.post(CE, () =>
        HttpResponse.json(
          {
            __type: "AccessDeniedException",
            Message: "User is not authorized",
          },
          {
            status: 403,
            headers: { "Content-Type": "application/x-amz-json-1.1" },
          },
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
                Metrics: { BlendedCost: { Amount: "9", Unit: "USD" } },
              },
            ]),
          ],
        }),
      ),
    )
    await expect(rows(DAYS)).rejects.toThrow(
      "missing NetUnblendedCost and UnblendedCost",
    )
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

type CeBody = { GroupBy: { Key: string }[]; NextPageToken?: string }

/** The second GroupBy key: SERVICE for the usage query, RECORD_TYPE for the query of the other record types. */
function groupKey(body: CeBody): string | undefined {
  return body.GroupBy[1]?.Key
}

function awsRow(
  day: string,
  accountId: string,
  sku: string,
  costUsd: number,
  account: string,
): CostRow {
  return {
    day,
    provider: "aws",
    sku,
    scope: `${accountId}/${sku}`,
    usage: 0,
    unit: "",
    costUsd,
    source: "reported",
    account,
  }
}

function group(account: string, key: string, cost: string) {
  return {
    Keys: [account, key],
    Metrics: { NetUnblendedCost: { Amount: cost, Unit: "USD" } },
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
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10)
}

function ceJson(body: Record<string, unknown>) {
  return HttpResponse.json(body, {
    headers: { "Content-Type": "application/x-amz-json-1.1" },
  })
}
