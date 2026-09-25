import { metrics } from "@opentelemetry/api"

function counter(name: string) {
  return metrics.getMeter("ctxpipe-backend").createCounter(name)
}

export function recordAdvisorCall(orgId: string): void {
  if (!orgId) return
  counter("ctxpipe.advisor.calls").add(1, { "ctxpipe.org.id": orgId })
}

export function recordIngestionJob(orgId: string): void {
  if (!orgId) return
  counter("ctxpipe.ingestion.jobs").add(1, { "ctxpipe.org.id": orgId })
}

export function recordConnectorSync(orgId: string, connector: string): void {
  if (!orgId || !connector) return
  counter("ctxpipe.connector.syncs").add(1, {
    "ctxpipe.org.id": orgId,
    "ctxpipe.connector.type": connector,
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

export function recordEnqueuedWorkflow(
  workflowName: string,
  input: unknown,
): void {
  if (!input || typeof input !== "object") return
  const orgId = (input as { orgId?: unknown }).orgId
  if (typeof orgId !== "string" || !orgId) return
  if (
    workflowName === "repository-ingestion" ||
    workflowName === "repository-ingestion-orchestrator" ||
    workflowName === "repository-index"
  ) {
    recordIngestionJob(orgId)
  }
  const connector = connectorTypeFromWorkflow(workflowName)
  const ingestion =
    workflowName === "repository-ingestion" ||
    workflowName === "repository-ingestion-orchestrator" ||
    workflowName === "repository-index"
  if (connector && !ingestion) recordConnectorSync(orgId, connector)
}
