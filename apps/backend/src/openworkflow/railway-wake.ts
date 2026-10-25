import { sql } from "drizzle-orm"

import { getSystemDb } from "../db/client.js"
import { log } from "../observability/logger.js"
import { openWorkflowNamespaceId } from "./namespace.js"

// Slack retries (~3s) plus PR worker boot (~30s). A 25s window still stacked
// serviceInstanceDeployV2 calls that replaced workers mid-start (PR-267).
const DEBOUNCE_MS = 120_000

/** Same as Terraform `railway_service.open_workflow.name`. */
const OPENWORKFLOW_SERVICE_NAME = "openworkflow"

function isRailwayPrPreview(): boolean {
  const name = process.env.RAILWAY_ENVIRONMENT_NAME?.trim()
  return Boolean(name?.startsWith("pr-"))
}

let lastWakeAt = 0
let pendingWake: Promise<void> | undefined
let cachedOpenworkflowServiceId: string | undefined | null

async function railwayGraphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: {
      // RAILWAY_TOKEN is a Railway project token scoped to this preview
      // environment. Railway reads a project token from this header only.
      "Project-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Railway GraphQL HTTP ${res.status}: ${text.slice(0, 500)}`)
  }
  return res.json()
}

async function resolveOpenworkflowServiceId(
  token: string,
  projectId: string,
): Promise<string | undefined> {
  if (cachedOpenworkflowServiceId !== undefined) {
    return cachedOpenworkflowServiceId === null
      ? undefined
      : cachedOpenworkflowServiceId
  }
  const json = (await railwayGraphql(
    token,
    `query ProjectServices($id: String!) {
      project(id: $id) {
        services {
          edges {
            node { id name }
          }
        }
      }
    }`,
    { id: projectId },
  )) as {
    errors?: { message: string }[]
    data?: {
      project?: {
        services?: {
          edges?: { node?: { id?: string; name?: string } }[]
        }
      }
    }
  }
  if (json.errors?.length) {
    log.warn({
      step: "railway-wake-worker.resolve_failed",
      message: json.errors.map((e) => e.message).join("; "),
    })
    cachedOpenworkflowServiceId = null
    return undefined
  }
  const edges = json.data?.project?.services?.edges ?? []
  const match = edges.find((e) => e.node?.name === OPENWORKFLOW_SERVICE_NAME)
    ?.node?.id
  if (!match) {
    log.warn({
      step: "railway-wake-worker.resolve_missing",
      message: `No Railway service named "${OPENWORKFLOW_SERVICE_NAME}" in project`,
    })
    cachedOpenworkflowServiceId = null
    return undefined
  }
  cachedOpenworkflowServiceId = match
  return match
}

async function deployWorkerService(
  token: string,
  environmentId: string,
  serviceId: string,
): Promise<void> {
  const body = {
    query: `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
      serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
    }`,
    variables: { environmentId, serviceId },
  }
  const res = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: {
      // RAILWAY_TOKEN is a Railway project token scoped to this preview
      // environment. Railway reads a project token from this header only.
      "Project-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `Railway GraphQL deploy failed: ${res.status} ${text.slice(0, 500)}`,
    )
  }
  const json = (await res.json()) as {
    errors?: { message: string }[]
    data?: unknown
  }
  if (json.errors?.length) {
    throw new Error(
      `Railway GraphQL deploy errors: ${json.errors.map((e) => e.message).join("; ")}`,
    )
  }
}

type WakeParams = { token: string; projectId: string; environmentId: string }

function wakeParamsFromEnv(): WakeParams | undefined {
  if (!isRailwayPrPreview()) return undefined
  const token = process.env.RAILWAY_TOKEN?.trim()
  const projectId = process.env.RAILWAY_PROJECT_ID?.trim()
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID?.trim()
  if (!token) {
    log.warn({
      step: "railway-wake-worker.misconfigured",
      message:
        "PR preview: RAILWAY_TOKEN is not set on backend; cannot wake openworkflow worker",
    })
    return undefined
  }
  if (!projectId || !environmentId) {
    log.warn({
      step: "railway-wake-worker.misconfigured",
      message:
        "PR preview: RAILWAY_PROJECT_ID or RAILWAY_ENVIRONMENT_ID missing (Railway should inject these)",
    })
    return undefined
  }
  return { token, projectId, environmentId }
}

/**
 * True when a worker holds the lease of a run now. That worker is alive and
 * claims new runs itself. A redeploy would stop its steps, so a step longer
 * than one wake interval would never end.
 */
async function workerHoldsLiveLease(): Promise<boolean> {
  try {
    const result = await getSystemDb().execute<{ live: boolean }>(sql`
      select exists (
        select 1 from openworkflow.workflow_runs
        where namespace_id = ${openWorkflowNamespaceId()}
          and status = 'running'
          and worker_id is not null
          and available_at > now()
      ) as live
    `)
    return result.rows[0]?.live === true
  } catch (error) {
    log.warn({
      step: "railway-wake-worker.lease_check_failed",
      message: "Could not read the run leases, so the wake continues",
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

async function runWakeOnce(params: WakeParams): Promise<void> {
  if (await workerHoldsLiveLease()) {
    log.info({
      step: "railway-wake-worker.skipped",
      message: "A worker holds a live run lease, so it runs already",
    })
    return
  }
  const workerServiceId = await resolveOpenworkflowServiceId(
    params.token,
    params.projectId,
  )
  if (!workerServiceId) return

  lastWakeAt = Date.now()
  try {
    await deployWorkerService(
      params.token,
      params.environmentId,
      workerServiceId,
    )
    log.info({
      step: "railway-wake-worker.deployed",
      message:
        "Triggered Railway openworkflow deploy after OpenWorkflow enqueue",
    })
  } catch (err) {
    log.error({
      step: "railway-wake-worker.failed",
      message: "Railway worker deploy failed; will retry once",
      error: err instanceof Error ? err.message : String(err),
    })
    await new Promise((r) => setTimeout(r, 3000))
    try {
      await deployWorkerService(
        params.token,
        params.environmentId,
        workerServiceId,
      )
      log.info({
        step: "railway-wake-worker.retry_ok",
        message: "Railway worker deploy succeeded on retry",
      })
    } catch (err2) {
      log.error({
        step: "railway-wake-worker.retry_failed",
        message: "Railway worker deploy failed after retry",
        error: err2 instanceof Error ? err2.message : String(err2),
      })
    }
  }
}

/**
 * After enqueueing OpenWorkflow work on Railway PR preview, redeploy the openworkflow service.
 * Debounced; uses RAILWAY_TOKEN and Railway-provided RAILWAY_* ids only when RAILWAY_ENVIRONMENT_NAME starts with pr-.
 * It does not redeploy while a worker holds a live run lease. The promise
 * resolves when the wake or the skip is done; callers need not wait for it.
 */
export function scheduleEnsureWorkerRunning(): Promise<void> {
  const params = wakeParamsFromEnv()
  if (!params) return Promise.resolve()

  const now = Date.now()
  const elapsed = now - lastWakeAt
  if (elapsed < DEBOUNCE_MS) {
    pendingWake ??= (async () => {
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS - elapsed))
      pendingWake = undefined
      const fresh = wakeParamsFromEnv()
      if (fresh) await runWakeOnce(fresh)
    })()
    return pendingWake
  }
  return runWakeOnce(params)
}
