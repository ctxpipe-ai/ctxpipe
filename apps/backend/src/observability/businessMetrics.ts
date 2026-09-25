import { type Counter, type MeterProvider, metrics } from "@opentelemetry/api"

let cachedProvider: MeterProvider | undefined
const counters = new Map<string, Counter>()

function counter(name: string): Counter {
  const provider = metrics.getMeterProvider()
  if (provider !== cachedProvider) {
    counters.clear()
    cachedProvider = provider
  }
  const existing = counters.get(name)
  if (existing) return existing
  const instrument = provider.getMeter("ctxpipe-backend").createCounter(name)
  counters.set(name, instrument)
  return instrument
}

export function recordAdvisorCall(orgId: string): void {
  if (!orgId) return
  counter("ctxpipe.advisor.calls").add(1, { "ctxpipe.org.id": orgId })
}

export function recordIngestionJob(orgId: string): void {
  if (!orgId) return
  counter("ctxpipe.ingestion.jobs").add(1, { "ctxpipe.org.id": orgId })
}

export function recordConnectorSync(
  orgId: string,
  connector: string,
  outcome: "success" | "failure",
): void {
  if (!orgId || !connector) return
  counter("ctxpipe.connector.syncs").add(1, {
    "ctxpipe.org.id": orgId,
    "ctxpipe.connector.type": connector,
    outcome,
  })
}

export function connectorTypeFromWorkflow(name: string): string | undefined {
  if (name.includes("pagerduty")) return "pagerduty"
  if (name.includes("linear")) return "linear"
  if (name.includes("notion")) return "notion"
  if (name.includes("slack")) return "slack"
  if (name.includes("confluence")) return "confluence"
  if (name.includes("forge")) return "forge"
  if (name.includes("github")) return "github"
  return undefined
}

const INGESTION_WORKFLOWS = new Set([
  "repository-ingestion",
  "repository-ingestion-orchestrator",
  "repository-index",
])

/** Startup PR-mirror ensure is not a connector sync. */
export function connectorSyncTypeForEnqueuedWorkflow(
  workflowName: string,
): string | undefined {
  if (workflowName === "github-ensure-pr-mirror") return undefined
  if (INGESTION_WORKFLOWS.has(workflowName)) return undefined
  return connectorTypeFromWorkflow(workflowName)
}

export function recordEnqueuedWorkflow(
  workflowName: string,
  input: unknown,
): void {
  if (!input || typeof input !== "object") return
  const orgId = (input as { orgId?: unknown }).orgId
  if (typeof orgId !== "string" || !orgId) return
  if (INGESTION_WORKFLOWS.has(workflowName)) recordIngestionJob(orgId)
}

/**
 * One count per root sync workflow, after it finishes.
 * Nested fan-out (config → content, enqueued from a job) is skipped by the caller.
 */
export function recordTerminalConnectorSync(
  workflowName: string | undefined,
  input: unknown,
  outcome: "success" | "failure",
): void {
  if (!workflowName || !input || typeof input !== "object") return
  const orgId = (input as { orgId?: unknown }).orgId
  if (typeof orgId !== "string" || !orgId) return
  const connector = connectorSyncTypeForEnqueuedWorkflow(workflowName)
  if (!connector) return
  recordConnectorSync(orgId, connector, outcome)
}
