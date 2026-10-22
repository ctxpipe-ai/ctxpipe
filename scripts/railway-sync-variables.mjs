#!/usr/bin/env node
// Copy GitHub Environment secrets to Railway service variables.
//
// The values go straight to Railway, so they never enter Terraform inputs,
// plans, or state. Terraform owns only the variables that are not secret.

import { appendFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { pathToFileURL } from "node:url"

// Railway variable -> GitHub Environment secret, for each Railway service.
const PRODUCT_APP = {
  "AUTH_SECRET": "BETTER_AUTH_SECRET",
  "CONNECTION_SECRETS_ENCRYPTION_KEY": "CONNECTION_SECRETS_ENCRYPTION_KEY",
  "MODEL_PROVIDER_API_KEY": "MODEL_PROVIDER_API_KEY",
  "SMTP_CONNECTION_URL": "SMTP_CONNECTION_URL",
  "GITHUB_PRIVATE_KEY": "GH_PRIVATE_KEY",
  "GITHUB_CLIENT_SECRET": "GH_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET": "GH_WEBHOOK_SECRET",
  "ATLASSIAN_CLIENT_ID": "ATLASSIAN_CLIENT_ID",
  "ATLASSIAN_CLIENT_SECRET": "ATLASSIAN_CLIENT_SECRET",
  "NOTION_CLIENT_ID": "NOTION_CLIENT_ID",
  "NOTION_CLIENT_SECRET": "NOTION_CLIENT_SECRET",
  "NOTION_WEBHOOK_SECRET": "NOTION_WEBHOOK_SECRET",
  "SLACK_CLIENT_ID": "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET": "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET": "SLACK_SIGNING_SECRET",
  "LINEAR_CLIENT_ID": "LINEAR_CLIENT_ID",
  "LINEAR_CLIENT_SECRET": "LINEAR_CLIENT_SECRET",
  "LINEAR_WEBHOOK_SECRET": "LINEAR_WEBHOOK_SECRET",
  "PAGERDUTY_CLIENT_ID": "PAGERDUTY_CLIENT_ID",
  "PAGERDUTY_CLIENT_SECRET": "PAGERDUTY_CLIENT_SECRET",
  "VERCEL_TOKEN": "VERCEL_ACCESS_TOKEN",
  "OTEL_EXPORTER_OTLP_HEADERS": "OBSERVABILITY_OTLP_HEADERS",
  "BETTER_AUTH_API_KEY": "BETTER_AUTH_API_KEY",
  "CONFLUENCE_FORGE_INSTALL_URL": "CONFLUENCE_FORGE_INSTALL_URL",
}
export const SERVICE_VARIABLES = {
  // Product project (GitHub Environment `production`).
  backend: PRODUCT_APP,
  openworkflow: PRODUCT_APP,
  codesearch: {
    "AUTH_SECRET": "BETTER_AUTH_SECRET",
    "OTEL_EXPORTER_OTLP_HEADERS": "OBSERVABILITY_OTLP_HEADERS",
  },
  ui: {"OTEL_EXPORTER_OTLP_HEADERS": "OBSERVABILITY_OTLP_HEADERS"},
  falkordb: {"FALKORDB_PASSWORD": "FALKORDB_PASSWORD"},
  // Observability project (GitHub Environment `observability`).
  clickhouse: {
    "CLICKHOUSE_OTEL_PASSWORD": "CLICKHOUSE_OTEL_PASSWORD",
    "CLICKHOUSE_LANGFUSE_PASSWORD": "CLICKHOUSE_LANGFUSE_PASSWORD",
  },
  // The workflow makes LANGFUSE_AUTH_STRING from the Langfuse project keys.
  collector: {
    "HYPERDX_API_KEY": "HYPERDX_API_KEY",
    "LANGFUSE_AUTH_STRING": "LANGFUSE_AUTH_STRING",
  },
  // langfuse-worker refers to the database URLs, SALT and ENCRYPTION_KEY of
  // langfuse-web.
  "langfuse-web": {
    "DATABASE_URL": "LANGFUSE_DATABASE_URL",
    "DIRECT_URL": "LANGFUSE_DIRECT_URL",
    "NEXTAUTH_SECRET": "LANGFUSE_NEXTAUTH_SECRET",
    "SALT": "LANGFUSE_SALT",
    "ENCRYPTION_KEY": "LANGFUSE_ENCRYPTION_KEY",
    "LANGFUSE_INIT_PROJECT_PUBLIC_KEY": "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_INIT_PROJECT_SECRET_KEY": "LANGFUSE_SECRET_KEY",
  },
  // No secret of their own: they refer to the values above, so they only
  // redeploy (--redeploy) after a change.
  hyperdx: {},
  "langfuse-worker": {},
  // Both telemetry services read Railway with the same workspace token.
  "cost-telemetry": {
    "OPENROUTER_MANAGEMENT_KEY": "COST_TELEMETRY_OPENROUTER_MANAGEMENT_KEY",
    "GITHUB_BILLING_TOKEN": "COST_TELEMETRY_GITHUB_BILLING_TOKEN",
    "BLACKSMITH_TOKEN": "COST_TELEMETRY_BLACKSMITH_TOKEN",
    "NEON_API_KEY": "COST_TELEMETRY_NEON_API_KEY",
    "NEON_ORG_ID": "COST_TELEMETRY_NEON_ORG_ID",
    "CLOUDFLARE_API_TOKEN": "COST_TELEMETRY_CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID": "COST_TELEMETRY_CLOUDFLARE_ACCOUNT_ID",
    "RAILWAY_API_TOKEN": "TELEMETRY_RAILWAY_WORKSPACE_TOKEN",
    "AWS_ACCESS_KEY_ID": "COST_TELEMETRY_AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY": "COST_TELEMETRY_AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN": "COST_TELEMETRY_AWS_SESSION_TOKEN",
  },
  "railway-telemetry": {"RAILWAY_API_TOKEN": "TELEMETRY_RAILWAY_WORKSPACE_TOKEN"},
}
// Secrets that may be empty. An empty one is deleted from the service, so the
// service turns that integration off and an old value does not stay live.
const OPTIONAL = new Set([
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "LINEAR_CLIENT_ID",
  "LINEAR_CLIENT_SECRET",
  "LINEAR_WEBHOOK_SECRET",
  "PAGERDUTY_CLIENT_ID",
  "PAGERDUTY_CLIENT_SECRET",
  "COST_TELEMETRY_AWS_SESSION_TOKEN",
  "BETTER_AUTH_API_KEY",
  "CONFLUENCE_FORGE_INSTALL_URL",
  // Optional for now: production has no value yet. Without it, the backend
  // refuses each Notion webhook that has no stored verification token.
  "NOTION_WEBHOOK_SECRET",
])
// Variables that no code uses any more. The sync deletes them from each
// service it writes.
// Langfuse uses LANGFUSE_INIT_USER_* only on an empty database, to make the
// first user. Our Langfuse has that user.
const RETIRED = new Set([
  "BETTER_STACK_TOKEN",
  "LANGFUSE_INIT_USER_EMAIL",
  "LANGFUSE_INIT_USER_PASSWORD",
])
// A Railway PR preview starts as a copy of the production variables. With
// --preview, the values come from the GitHub Environment `Preview`, and each
// empty one is deleted, so no production value stays. The preview scripts own
// these names (a value made for each preview, the preview GitHub App, the
// preview Vercel project, the OTLP header):
const PREVIEW_OWNED = new Set([
  "AUTH_SECRET",
  "CONNECTION_SECRETS_ENCRYPTION_KEY",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "VERCEL_TOKEN",
  "OTEL_EXPORTER_OTLP_HEADERS",
])
// A preview cannot start without these.
const PREVIEW_REQUIRED = new Set(["MODEL_PROVIDER_API_KEY", "FALKORDB_PASSWORD"])
// Checked before any write, so a bad value never reaches a service.
const FORMATS = {
  CONNECTION_SECRETS_ENCRYPTION_KEY: /^[0-9a-fA-F]{64}$/,
  LANGFUSE_ENCRYPTION_KEY: /^[0-9a-fA-F]{64}$/,
}

async function graphql(query, variables, token) {
  // A variableDelete starts a redeploy, and Railway can take more than 30
  // seconds to answer it. Wait 2 minutes, as railway-graphql.sh does.
  const response = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "ctxpipe-railway-sync/1.0",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    throw new Error(`Railway API returned HTTP ${response.status}`)
  }
  const payload = await response.json().catch(() => null)
  if (
    !isObject(payload) ||
    (Array.isArray(payload.errors) ? payload.errors.length : payload.errors) ||
    !isObject(payload.data)
  ) {
    throw new Error("Railway API returned an invalid or failed GraphQL response")
  }
  return payload.data
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function currentVariables(projectId, environmentId, serviceId, token) {
  const data = await graphql(
    "query variables($projectId: String!, $environmentId: String!, $serviceId: String) " +
      "{ variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }",
    { projectId, environmentId, serviceId },
    token,
  )
  if (!isObject(data.variables)) {
    throw new Error("Railway did not return service variables")
  }
  return data.variables
}

export async function main(
  argv,
  env,
  { log = console.log, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  const { values: args } = parseArgs({
    args: argv,
    options: {
      "redeploy-on-change": { type: "boolean" },
      // Redeploys even when no value changed: a re-run, after an attempt that
      // wrote the values but whose redeploy failed.
      redeploy: { type: "boolean" },
      service: { type: "string" },
      // Appends the service name to this file when a value changed.
      "changed-file": { type: "string" },
      preview: { type: "boolean" },
    },
  })
  if (!args.service) {
    throw new Error("--service is required")
  }
  if (!Object.hasOwn(SERVICE_VARIABLES, args.service)) {
    throw new Error(
      `Unknown service ${args.service}. Choose one of: ${Object.keys(SERVICE_VARIABLES).join(", ")}`,
    )
  }
  const service = args.service
  let variables = SERVICE_VARIABLES[service]
  let optional = OPTIONAL
  if (args.preview) {
    variables = Object.fromEntries(
      Object.entries(variables).filter(([name]) => !PREVIEW_OWNED.has(name)),
    )
    optional = new Set(
      Object.values(variables).filter((source) => !PREVIEW_REQUIRED.has(source)),
    )
  }

  const required = [
    "PROJECT_ID",
    "ENVIRONMENT_ID",
    "SERVICE_ID",
    ...Object.values(variables).filter((source) => !optional.has(source)),
  ]
  const missing = required.filter((name) => !env[name])
  const token = env.RAILWAY_TOKEN || env.RAILWAY_API_TOKEN
  if (!token) {
    missing.push("RAILWAY_TOKEN")
  }
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`)
  }
  const malformed = Object.entries(FORMATS)
    .filter(([source, pattern]) => Object.values(variables).includes(source) && !pattern.test(env[source]))
    .map(([source]) => source)
  if (malformed.length) {
    throw new Error(`Malformed values: ${malformed.join(", ")}`)
  }

  const projectId = env.PROJECT_ID
  const environmentId = env.ENVIRONMENT_ID
  const serviceId = env.SERVICE_ID
  const desired = Object.fromEntries(
    Object.entries(variables)
      .filter(([, source]) => env[source])
      .map(([name, source]) => [name, env[source]]),
  )

  const existing = await currentVariables(projectId, environmentId, serviceId, token)
  const changed = Object.fromEntries(
    Object.entries(desired).filter(([name, value]) => existing[name] !== value),
  )
  const changedCount = Object.keys(changed).length
  const removed = [...Object.keys(variables), ...[...RETIRED].sort()].filter(
    (name) => !Object.hasOwn(desired, name) && Object.hasOwn(existing, name),
  )
  if (!changedCount && !removed.length) {
    log(`${service} credentials already match GitHub Environment`)
  }
  if (changedCount) {
    await graphql(
      "mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) " +
        "{ variableCollectionUpsert(input: $input) }",
      {
        input: {
          projectId,
          environmentId,
          serviceId,
          variables: changed,
          skipDeploys: true,
        },
      },
      token,
    )
  }
  // variableDelete has no skipDeploys, so a delete can redeploy the service
  // on its current image. It happens when an optional connector is turned
  // off, and on a new preview for each production value that Preview does
  // not set. The service then starts without it.
  for (const name of removed) {
    await graphql(
      "mutation variableDelete($input: VariableDeleteInput!) { variableDelete(input: $input) }",
      { input: { projectId, environmentId, serviceId, name } },
      token,
    )
  }
  if (changedCount || removed.length) {
    const updated = await currentVariables(projectId, environmentId, serviceId, token)
    if (
      Object.entries(changed).some(([name, value]) => updated[name] !== value) ||
      removed.some((name) => Object.hasOwn(updated, name))
    ) {
      throw new Error(`Railway did not retain every ${service} credential`)
    }
    log(
      `Synced ${changedCount} and removed ${removed.length} ${service} variables ` +
        "from GitHub Environment",
    )
    if (args["changed-file"]) {
      appendFileSync(args["changed-file"], `${service}\n`, "utf8")
    }
  }

  if (!(args.redeploy || (args["redeploy-on-change"] && (changedCount || removed.length)))) {
    return
  }
  let data = await graphql(
    "mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) " +
      "{ serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }",
    { serviceId, environmentId },
    token,
  )
  const deploymentId = data.serviceInstanceDeployV2
  if (typeof deploymentId !== "string" || !deploymentId) {
    throw new Error("Railway did not return a deployment ID")
  }
  const deadline = Date.now() + 600_000
  while (Date.now() < deadline) {
    data = await graphql(
      "query deployments($input: DeploymentListInput!) " +
        "{ deployments(input: $input) { edges { node { id status } } } }",
      { input: { environmentId, serviceId } },
      token,
    )
    const edges = data.deployments?.edges ?? []
    const statuses = edges
      .filter((edge) => isObject(edge) && isObject(edge.node) && edge.node.id === deploymentId)
      .map((edge) => edge.node.status)
    if (statuses.length) {
      if (["SUCCESS", "SLEEPING"].includes(statuses[0])) {
        log(`${service} redeployment succeeded`)
        return
      }
      if (["FAILED", "CRASHED"].includes(statuses[0])) {
        throw new Error(`${service} redeployment ended ${statuses[0]}`)
      }
    }
    await sleep(10_000)
  }
  throw new Error(`Timed out waiting for ${service} redeployment`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
