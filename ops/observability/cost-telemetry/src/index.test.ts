import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { otlpHeaders, run } from "./index"
import type { OtlpMetricsRequest } from "./rows"
import { useEnv } from "./test-env"

const COLLECTOR = "http://collector.test:4318/v1/metrics"
// 12:17 UTC: the Cost Explorer slot, so every entry runs.
const AWS_SLOT = new Date("2026-09-26T12:17:00.000Z")
const ALL = ["openrouter", "github", "github-plan", "blacksmith", "cloudflare", "aws", "linear", "fx"]

const server = setupServer()
useEnv({
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test:4318",
  OPENROUTER_MANAGEMENT_KEY: "or-key",
  GITHUB_BILLING_TOKEN: "gh-token",
  BLACKSMITH_TOKEN: "bs-token",
  CLOUDFLARE_API_TOKEN: "cf-token",
  CLOUDFLARE_ACCOUNT_ID: "cf-account",
  LINEAR_API_KEY: "lin-key",
  AWS_ACCESS_KEY_ID: "AKIATASKROLE",
  AWS_SECRET_ACCESS_KEY: "task-secret",
})

let binDir = ""
const previousPath = process.env.PATH
let exports: OtlpMetricsRequest[] = []
const logs: string[] = []

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" })
})
beforeEach(() => {
  // A fake Blacksmith CLI on PATH: `auth login` succeeds and `usage` prints no days.
  binDir = mkdtempSync(join(tmpdir(), "blacksmith-cli-"))
  writeFileSync(join(binDir, "blacksmith"), `#!/bin/sh\nif [ "$1" = "usage" ]; then echo '{"daily":[]}'; fi\n`)
  chmodSync(join(binDir, "blacksmith"), 0o755)
  process.env.PATH = `${binDir}:${previousPath}`
  exports = []
  logs.length = 0
  spyOn(console, "log").mockImplementation((line: string) => void logs.push(line))
  spyOn(console, "error").mockImplementation((line: string) => void logs.push(line))
  server.use(...providers(), http.post(COLLECTOR, async ({ request }) => {
    exports.push((await request.json()) as OtlpMetricsRequest)
    return HttpResponse.json({})
  }))
})
afterEach(() => {
  mock.restore()
  process.env.PATH = previousPath
  rmSync(binDir, { recursive: true, force: true })
  setSystemTime()
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

describe("run", () => {
  test("sends status 1 for each provider entry when all succeed, and exits 0", async () => {
    setSystemTime(AWS_SLOT)
    expect(await run()).toBe(0)
    expect(statuses()).toEqual(ALL.map((provider) => ({ provider, value: 1, error: undefined })))
    const status = metric("billing.provider_status")?.gauge.dataPoints[0]
    expect(status?.timeUnixNano).toBe(`${BigInt(AWS_SLOT.getTime()) * 1_000_000n}`)
    expect(attr(status?.attributes, "billing.observed_at_unix_ms")).toBe(String(AWS_SLOT.getTime()))
    expect(metric("billing.fx_rate")?.gauge.dataPoints[0]?.asDouble).toBe(1.5)
  })

  test("a failed provider sends status 0 with its error class, the others still arrive, and the run exits 0", async () => {
    setSystemTime(AWS_SLOT)
    server.use(http.get("https://api.github.com/orgs/ctxpipe-ai", () => HttpResponse.json({ message: "secret-ish body" }, { status: 403 })))
    delete process.env.LINEAR_API_KEY
    expect(await run()).toBe(0)
    expect(statuses()).toEqual(
      ALL.map((provider) =>
        provider === "github-plan"
          ? { provider, value: 0, error: "http_403" }
          : provider === "linear"
            ? { provider, value: 0, error: "missing_env" }
            : { provider, value: 1, error: undefined },
      ),
    )
    expect(metric("billing.cost")?.gauge.dataPoints.map((point) => attr(point.attributes, "billing.provider"))).toContain("aws")
    expect(logs.join("\n")).toContain("failures=github-plan:http_403,linear:missing_env")
    expect(logs.join("\n")).not.toContain("secret-ish body")
  })

  test("sends no aws status outside the 12:17 UTC slot and does not call Cost Explorer", async () => {
    setSystemTime(new Date("2026-09-26T13:17:00.000Z"))
    let calls = 0
    server.use(
      http.post(/amazonaws\.com/, () => {
        calls += 1
        return HttpResponse.text("not expected", { status: 500 })
      }),
    )
    expect(await run()).toBe(0)
    expect(statuses().map((status) => status.provider)).toEqual(ALL.filter((provider) => provider !== "aws"))
    expect(calls).toBe(0)
  })

  test("exits 1 when the OTLP export fails", async () => {
    setSystemTime(AWS_SLOT)
    server.use(http.post(COLLECTOR, () => HttpResponse.text("unavailable", { status: 503 })))
    expect(await run()).toBe(1)
    expect(logs.join("\n")).toContain("cost-telemetry OTLP export failed: http_5xx")
  })
})

describe("run with provider inputs from Secrets Manager", () => {
  const SECRETS = /https:\/\/secretsmanager\.us-west-2\.amazonaws\.com\/?$/
  const OUTSIDE_AWS_SLOT = new Date("2026-09-26T13:17:00.000Z")

  // The ECS task: ECS sets its metadata endpoint, and no provider env vars. BLACKSMITH_TOKEN stays in the env, which
  // wins over its secret.
  beforeEach(() => {
    process.env.ECS_CONTAINER_METADATA_URI_V4 = "http://169.254.170.2/v4/task-1"
    for (const name of ["OPENROUTER_MANAGEMENT_KEY", "GITHUB_BILLING_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "LINEAR_API_KEY"]) {
      delete process.env[name]
    }
  })
  afterEach(() => {
    delete process.env.ECS_CONTAINER_METADATA_URI_V4
  })

  function secrets(values: Record<string, string | { error: string; status: number }>, asked: string[]) {
    return http.post(SECRETS, async ({ request }) => {
      expect(request.headers.get("x-amz-target")).toBe("secretsmanager.GetSecretValue")
      const { SecretId } = (await request.json()) as { SecretId: string }
      asked.push(SecretId)
      const value = values[SecretId]
      if (value === undefined || typeof value !== "string") {
        const error = value ?? { error: "ResourceNotFoundException", status: 400 }
        return HttpResponse.json(
          { __type: error.error, message: "Secrets Manager can't find the specified secret." },
          { status: error.status, headers: { "Content-Type": "application/x-amz-json-1.1" } },
        )
      }
      return HttpResponse.json({ Name: SecretId, SecretString: value, VersionStages: ["AWSCURRENT"] }, { headers: { "Content-Type": "application/x-amz-json-1.1" } })
    })
  }

  test("uses a present secret, fails only the provider of a missing one, and keeps the env over the secret", async () => {
    setSystemTime(OUTSIDE_AWS_SLOT)
    const asked: string[] = []
    const authorizations: (string | null)[] = []
    server.use(
      secrets(
        {
          "cost-telemetry/OPENROUTER_MANAGEMENT_KEY": "or-secret",
          "cost-telemetry/GITHUB_BILLING_TOKEN": "gh-secret",
          "cost-telemetry/CLOUDFLARE_API_TOKEN": "cf-secret",
          "cost-telemetry/CLOUDFLARE_ACCOUNT_ID": "cf-account",
        },
        asked,
      ),
      http.get("https://api.github.com/organizations/ctxpipe-ai/settings/billing/usage", ({ request }) => {
        authorizations.push(request.headers.get("Authorization"))
        return HttpResponse.json({ usageItems: [] })
      }),
    )
    expect(await run()).toBe(0)
    expect(statuses()).toEqual(
      ALL.filter((provider) => provider !== "aws").map((provider) =>
        provider === "linear" ? { provider, value: 0, error: "missing_env" } : { provider, value: 1, error: undefined },
      ),
    )
    expect(authorizations).toContain("Bearer gh-secret")
    expect(asked.sort()).toEqual([
      "cost-telemetry/CLOUDFLARE_ACCOUNT_ID",
      "cost-telemetry/CLOUDFLARE_API_TOKEN",
      "cost-telemetry/GITHUB_BILLING_TOKEN",
      "cost-telemetry/LINEAR_API_KEY",
      "cost-telemetry/OPENROUTER_MANAGEMENT_KEY",
    ])
    expect(logs.join("\n")).toContain("inputs=LINEAR_API_KEY:missing_env")
    expect(logs.join("\n")).not.toContain("gh-secret")
  })

  test("an empty secret is missing, and another read error fails only its providers with secret_read", async () => {
    setSystemTime(OUTSIDE_AWS_SLOT)
    server.use(
      secrets(
        {
          "cost-telemetry/OPENROUTER_MANAGEMENT_KEY": "",
          "cost-telemetry/GITHUB_BILLING_TOKEN": { error: "AccessDeniedException", status: 400 },
          "cost-telemetry/CLOUDFLARE_API_TOKEN": "cf-secret",
          "cost-telemetry/CLOUDFLARE_ACCOUNT_ID": "cf-account",
          "cost-telemetry/LINEAR_API_KEY": "lin-secret",
        },
        [],
      ),
    )
    expect(await run()).toBe(0)
    const failed = Object.fromEntries(statuses().filter((status) => status.value === 0).map((status) => [status.provider, status.error]))
    expect(failed).toEqual({ openrouter: "missing_env", github: "secret_read", "github-plan": "secret_read" })
  })
})

describe("otlpHeaders", () => {
  test("sends no headers to the in-VPC collector when OTEL_EXPORTER_OTLP_HEADERS is not set", () => {
    expect(otlpHeaders("")).toEqual({})
  })

  test("decodes the headers of OTEL_EXPORTER_OTLP_HEADERS when it is set", () => {
    expect(otlpHeaders("cf-access-client-id=id, cf-access-client-secret=a%3Db,bad")).toEqual({
      "cf-access-client-id": "id",
      "cf-access-client-secret": "a=b",
    })
  })
})

function metric(name: string) {
  return exports[0]?.resourceMetrics[0]?.scopeMetrics[0]?.metrics.find((item) => item.name === name)
}

function statuses() {
  return (metric("billing.provider_status")?.gauge.dataPoints ?? []).map((point) => ({
    provider: attr(point.attributes, "billing.provider"),
    value: point.asDouble,
    error: attr(point.attributes, "billing.error"),
  }))
}

function attr(attributes: { key: string; value: { stringValue: string } }[] | undefined, key: string) {
  return attributes?.find((attribute) => attribute.key === key)?.value.stringValue
}

// Each provider API answers with an empty or small valid response.
function providers() {
  return [
    http.get("https://openrouter.ai/api/v1/activity", () => HttpResponse.json({ data: [] })),
    http.get("https://api.github.com/organizations/ctxpipe-ai/settings/billing/usage", () => HttpResponse.json({ usageItems: [] })),
    http.get("https://api.github.com/orgs/ctxpipe-ai", () => HttpResponse.json({ plan: { name: "team", space: 1, private_repos: 1, seats: 2 } })),
    http.get("https://api.cloudflare.com/client/v4/accounts/cf-account/billing/history", () => HttpResponse.json({ success: true, result: [] })),
    http.post("https://api.cloudflare.com/client/v4/graphql", () => HttpResponse.json({ data: { viewer: { accounts: [{}] } } })),
    http.post("https://api.linear.app/graphql", () =>
      HttpResponse.json({ data: { organization: { subscription: { type: "business_yearly", seats: 3 } } } }),
    ),
    http.get("https://api.frankfurter.dev/v2/rates", () => HttpResponse.json([{ date: "2026-09-25", base: "USD", quote: "AUD", rate: 1.5 }])),
    http.post(/https:\/\/sts\.us-east-1\.amazonaws\.com\/?$/, () =>
      HttpResponse.xml(
        `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ASIAASSUMED</AccessKeyId><SecretAccessKey>s</SecretAccessKey><SessionToken>t</SessionToken><Expiration>2026-09-26T13:17:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`,
      ),
    ),
    http.post(/https:\/\/ce\.us-east-1\.amazonaws\.com\/?$/, () =>
      HttpResponse.json(
        {
          ResultsByTime: [
            {
              TimePeriod: { Start: "2026-09-26", End: "2026-09-27" },
              Groups: [{ Keys: ["213102790567", "AWS Lambda"], Metrics: { NetUnblendedCost: { Amount: "1", Unit: "USD" } } }],
            },
          ],
        },
        { headers: { "Content-Type": "application/x-amz-json-1.1" } },
      ),
    ),
  ]
}
