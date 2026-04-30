import { log } from "../observability/logger.js"

const DEBOUNCE_MS = 25_000

let lastWakeAt = 0
let pendingWake = false

type WakeConfig = {
  token: string
  projectId: string
  environmentId: string
  serviceId: string
}

function wakeConfigFromEnv(): WakeConfig | undefined {
  if (process.env.RAILWAY_WAKE_WORKER_ENABLED !== "true") return undefined
  const token = process.env.RAILWAY_WAKE_API_TOKEN
  const projectId = process.env.RAILWAY_WAKE_PROJECT_ID
  const environmentId = process.env.RAILWAY_WAKE_ENVIRONMENT_ID
  const serviceId = process.env.RAILWAY_WAKE_SERVICE_ID
  if (!token || !projectId || !environmentId || !serviceId) {
    log.warn({
      step: "railway-wake-worker.misconfigured",
      message:
        "RAILWAY_WAKE_WORKER_ENABLED is true but one of RAILWAY_WAKE_API_TOKEN, RAILWAY_WAKE_PROJECT_ID, RAILWAY_WAKE_ENVIRONMENT_ID, RAILWAY_WAKE_SERVICE_ID is missing",
    })
    return undefined
  }
  return { token, projectId, environmentId, serviceId }
}

async function deployWorkerService(cfg: WakeConfig): Promise<void> {
  const body = {
    query: `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
      serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
    }`,
    variables: {
      environmentId: cfg.environmentId,
      serviceId: cfg.serviceId,
    },
  }
  const res = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
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

async function runWakeOnce(cfg: WakeConfig): Promise<void> {
  lastWakeAt = Date.now()
  try {
    await deployWorkerService(cfg)
    log.info({
      step: "railway-wake-worker.deployed",
      message: "Triggered Railway worker deploy after OpenWorkflow enqueue",
    })
  } catch (err) {
    log.error({
      step: "railway-wake-worker.failed",
      message: "Railway worker deploy failed; will retry once",
      error: err instanceof Error ? err.message : String(err),
    })
    await new Promise((r) => setTimeout(r, 3000))
    try {
      await deployWorkerService(cfg)
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
 * After enqueueing OpenWorkflow work in preview (Railway), wake the worker service.
 * Debounced and best-effort; retries once on failure.
 */
export function scheduleEnsureWorkerRunning(): void {
  const cfg = wakeConfigFromEnv()
  if (!cfg) return

  const now = Date.now()
  const elapsed = now - lastWakeAt
  if (elapsed < DEBOUNCE_MS) {
    if (!pendingWake) {
      pendingWake = true
      void (async () => {
        await new Promise((r) => setTimeout(r, DEBOUNCE_MS - elapsed))
        pendingWake = false
        const fresh = wakeConfigFromEnv()
        if (fresh) await runWakeOnce(fresh)
      })()
    }
    return
  }
  void runWakeOnce(cfg)
}
