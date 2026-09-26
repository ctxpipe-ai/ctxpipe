import { type Counter, type MeterProvider, metrics } from "@opentelemetry/api"

let cachedProvider: MeterProvider | undefined
const counters = new Map<string, Counter>()

function counter(name: string): Counter {
  const provider = metrics.getMeterProvider()
  if (provider !== cachedProvider) {
    counters.clear()
    cachedProvider = provider
  }
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

const INGESTION_WORKFLOWS = new Set([
  "repository-ingestion",
  "repository-ingestion-orchestrator",
  "repository-index",
])

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
 * Nested fan-out is skipped by the caller. `connectorType` comes from the
 * workflow definition, not the workflow name.
 */
export function recordTerminalConnectorSync(
  connectorType: string | undefined,
  input: unknown,
  outcome: "success" | "failure",
): void {
  if (!connectorType || !input || typeof input !== "object") return
  const orgId = (input as { orgId?: unknown }).orgId
  if (typeof orgId !== "string" || !orgId) return
  recordConnectorSync(orgId, connectorType, outcome)
}
