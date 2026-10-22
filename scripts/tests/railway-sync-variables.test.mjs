import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, mock, test } from "node:test"
import { SERVICE_VARIABLES, main } from "../railway-sync-variables.mjs"

let calls
let current
let desired
let environment
let directory
let timeouts

const base = {
  PROJECT_ID: "project",
  ENVIRONMENT_ID: "environment",
  SERVICE_ID: "service",
  RAILWAY_TOKEN: "management-token",
}

beforeEach(() => {
  const variables = SERVICE_VARIABLES["cost-telemetry"]
  desired = Object.fromEntries(Object.keys(variables).map((name) => [name, `private-${name}`]))
  environment = {
    ...base,
    ...Object.fromEntries(Object.entries(variables).map(([name, source]) => [source, desired[name]])),
  }
  current = { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example" }
  calls = []
  timeouts = []
  directory = mkdtempSync(join(tmpdir(), "ctxpipe-railway-sync-"))
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  mock.method(AbortSignal, "timeout", (ms) => {
    timeouts.push(ms)
    return timeout(ms)
  })
  // The fake Railway HTTP API.
  mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://backboard.railway.com/graphql/v2")
    assert.equal(init.headers.Authorization, "Bearer management-token")
    assert.equal(init.headers["User-Agent"], "ctxpipe-railway-sync/1.0")
    const { query, variables } = JSON.parse(init.body)
    let data
    if (query.startsWith("query variables")) {
      calls.push("read")
      data = { variables: { ...current } }
    } else if (query.startsWith("mutation variableCollectionUpsert")) {
      calls.push("upsert")
      assert.equal(variables.input.skipDeploys, true)
      assert.equal(variables.input.serviceId, "service")
      Object.assign(current, variables.input.variables)
      data = { variableCollectionUpsert: true }
    } else if (query.startsWith("mutation variableDelete")) {
      calls.push("delete")
      delete current[variables.input.name]
      data = { variableDelete: true }
    } else if (query.startsWith("mutation serviceInstanceDeployV2")) {
      calls.push("deploy")
      data = { serviceInstanceDeployV2: "deployment" }
    } else if (query.startsWith("query deployments")) {
      calls.push("poll")
      data = { deployments: { edges: [{ node: { id: "deployment", status: "SUCCESS" } }] } }
    } else {
      throw new Error(`Unexpected Railway query: ${query}`)
    }
    return Response.json({ data })
  })
})

afterEach(() => {
  mock.restoreAll()
  rmSync(directory, { recursive: true, force: true })
})

async function runSync(args = [], service = "cost-telemetry") {
  const lines = []
  await main(["--service", service, ...args], environment, {
    log: (line) => lines.push(line),
    sleep: async () => {},
  })
  assert.ok(timeouts.every((ms) => ms === 120_000))
  return lines.join("\n")
}

test("initial sync precedes image deploy and preserves other variables", async () => {
  const output = await runSync()
  assert.deepEqual(calls, ["read", "upsert", "read"])
  assert.deepEqual(Object.fromEntries(Object.keys(desired).map((name) => [name, current[name]])), desired)
  assert.equal(current.OTEL_EXPORTER_OTLP_ENDPOINT, "https://collector.example")
  assert.doesNotMatch(output, /private-/)
})

test("rotation redeploys once and matching values are no-op", async () => {
  Object.assign(current, desired)
  current.NEON_API_KEY = "old-key"
  await runSync(["--redeploy-on-change"])
  assert.deepEqual(calls, ["read", "upsert", "read", "deploy", "poll"])
  calls.length = 0
  await runSync(["--redeploy-on-change"])
  assert.deepEqual(calls, ["read"])
})

test("railway-telemetry gets only the shared Railway token", async () => {
  await runSync([], "railway-telemetry")
  assert.deepEqual(calls, ["read", "upsert", "read"])
  assert.equal(current.RAILWAY_API_TOKEN, desired.RAILWAY_API_TOKEN)
  assert.ok(!("NEON_API_KEY" in current))
})

test("backend skips an empty optional integration", async () => {
  const backend = SERVICE_VARIABLES.backend
  environment = {
    ...base,
    ...Object.fromEntries(
      Object.entries(backend)
        .filter(([, source]) => !source.startsWith("SLACK_"))
        .map(([name, source]) => [source, `private-${name}`]),
    ),
    CONNECTION_SECRETS_ENCRYPTION_KEY: "ab".repeat(32),
  }
  await runSync([], "backend")
  assert.equal(current.AUTH_SECRET, "private-AUTH_SECRET")
  assert.equal(current.GITHUB_PRIVATE_KEY, "private-GITHUB_PRIVATE_KEY")
  assert.ok(!("SLACK_CLIENT_ID" in current))
})

test("backend deletes an optional secret that became empty", async () => {
  const backend = SERVICE_VARIABLES.backend
  environment = {
    ...base,
    ...Object.fromEntries(
      Object.entries(backend)
        .filter(([, source]) => source !== "PAGERDUTY_CLIENT_SECRET")
        .map(([name, source]) => [source, `private-${name}`]),
    ),
    CONNECTION_SECRETS_ENCRYPTION_KEY: "ab".repeat(32),
  }
  for (const [name, source] of Object.entries(backend)) {
    if (source in environment) current[name] = environment[source]
  }
  current.PAGERDUTY_CLIENT_SECRET = "leaked-old-value"
  const changed = join(directory, "changed")
  await runSync(["--changed-file", changed], "backend")
  assert.deepEqual(calls, ["read", "delete", "read"])
  assert.ok(!("PAGERDUTY_CLIENT_SECRET" in current))
  assert.equal(readFileSync(changed, "utf8"), "backend\n")
})

test("a malformed connection key fails before any Railway request", async () => {
  const backend = SERVICE_VARIABLES.backend
  environment = {
    ...base,
    ...Object.fromEntries(Object.entries(backend).map(([name, source]) => [source, `private-${name}`])),
  }
  await assert.rejects(runSync([], "backend"), /CONNECTION_SECRETS_ENCRYPTION_KEY/)
  assert.deepEqual(calls, [])
})

test("redeploy retries a deploy when the values already match", async () => {
  Object.assign(current, desired)
  const changed = join(directory, "changed")
  await runSync(["--redeploy", "--changed-file", changed])
  assert.deepEqual(calls, ["read", "deploy", "poll"])
  assert.equal(existsSync(changed), false)
})

test("a service with no secret only redeploys", async () => {
  await runSync(["--redeploy"], "langfuse-worker")
  assert.deepEqual(calls, ["read", "deploy", "poll"])
})

test("preview keeps no production value", async () => {
  environment = { ...base, MODEL_PROVIDER_API_KEY: "preview-model-key" }
  Object.assign(current, {
    AUTH_SECRET: "preview-own-auth-secret",
    MODEL_PROVIDER_API_KEY: "production-model-key",
    SLACK_CLIENT_SECRET: "production-slack-secret",
    BETTER_STACK_TOKEN: "retired-token",
  })
  await runSync(["--preview"], "backend")
  assert.equal(current.MODEL_PROVIDER_API_KEY, "preview-model-key")
  assert.equal(current.AUTH_SECRET, "preview-own-auth-secret")
  assert.ok(!("SLACK_CLIENT_SECRET" in current))
  assert.ok(!("BETTER_STACK_TOKEN" in current))
})

test("preview falkordb needs its own password", async () => {
  environment = { ...base }
  await assert.rejects(runSync(["--preview"], "falkordb"), /FALKORDB_PASSWORD/)
  assert.deepEqual(calls, [])
})

test("a missing credential fails before any Railway request", async () => {
  delete environment.COST_TELEMETRY_NEON_API_KEY
  await assert.rejects(runSync(), /COST_TELEMETRY_NEON_API_KEY/)
  assert.deepEqual(calls, [])
})
