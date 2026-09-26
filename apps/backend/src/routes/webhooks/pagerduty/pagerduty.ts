import type { OpenAPIHono } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { AppEnv } from "../../../app/env.js"
import { decryptConnectionSecret } from "../../../lib/connection-secrets.js"
import {
  getPagerdutyBindingWithRepoByConnectionId,
  listPagerdutyConnectionsByWebhookSubscriptionId,
} from "../../../models/pagerduty-connector.js"
import { getLogger } from "../../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../../../openworkflow/client.js"
import { pagerdutySyncEntity } from "../../../openworkflow/workflows/pagerduty-sync-entity.js"
import { loadPagerdutyScopeFromRepo } from "../../../services/pagerduty/config-from-repo.js"
import {
  pagerdutyEventIsStale,
  verifyPagerdutyWebhookSignature,
} from "../../../services/pagerduty/signature.js"
import { noteResolvedWebhookConnections } from "../attribution.js"

export function pagerdutyIncidentEventFromPayload(payload: unknown):
  | {
      eventId?: string
      eventType: string
      occurredAt?: string
      incidentId: string
      serviceId?: string
    }
  | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const event = (payload as { event?: unknown }).event
  if (!event || typeof event !== "object") return undefined
  const record = event as Record<string, unknown>
  const eventType =
    typeof record.event_type === "string" ? record.event_type : undefined
  if (!eventType?.startsWith("incident.")) return undefined
  const data =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : undefined
  if (!data) return undefined
  const incidentId = typeof data.id === "string" ? data.id : undefined
  if (!incidentId) return undefined
  const service =
    data.service && typeof data.service === "object"
      ? (data.service as Record<string, unknown>)
      : undefined
  return {
    eventId: typeof record.id === "string" ? record.id : undefined,
    eventType,
    occurredAt:
      typeof record.occurred_at === "string" ? record.occurred_at : undefined,
    incidentId,
    serviceId: typeof service?.id === "string" ? service.id : undefined,
  }
}

async function handlePagerdutyWebhook(c: Context<AppEnv>) {
  const rawBody = Buffer.from(await c.req.arrayBuffer())
  const subscriptionId = c.req.header("x-pagerduty-subscription")
  if (!subscriptionId) {
    return c.json({ error: "Missing PagerDuty subscription" }, 401)
  }

  const connections = await listPagerdutyConnectionsByWebhookSubscriptionId({
    webhookSubscriptionId: subscriptionId,
    env: c.var.env,
  })
  if (connections.length === 0) {
    return c.json({ error: "Unknown PagerDuty subscription" }, 401)
  }

  const connection = connections.find((candidate) => {
    if (!candidate.webhookSecretEnc) return false
    const secret = decryptConnectionSecret(
      candidate.webhookSecretEnc,
      c.var.env,
    )
    return verifyPagerdutyWebhookSignature({
      rawBody,
      signatureHeader: c.req.header("x-pagerduty-signature"),
      secret,
    })
  })
  if (!connection) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  noteResolvedWebhookConnections([connection])

  let payload: unknown
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as unknown
  } catch {
    return c.json({ error: "Bad request" }, 400)
  }

  const event = pagerdutyIncidentEventFromPayload(payload)
  if (!event) {
    return c.body(null, 200)
  }
  if (pagerdutyEventIsStale(event.occurredAt)) {
    return c.json({ error: "Stale PagerDuty event" }, 401)
  }

  if (
    connection.status !== "installed" ||
    !connection.repositoryId ||
    !connection.enabled ||
    connection.setupPhase !== "live"
  ) {
    return c.body(null, 200)
  }

  try {
    const binding = await getPagerdutyBindingWithRepoByConnectionId(
      connection.orgId,
      connection.id,
    )
    if (!binding?.githubConnectionId) {
      return c.body(null, 200)
    }
    const config = await loadPagerdutyScopeFromRepo({
      orgId: connection.orgId,
      env: c.var.env,
      repositoryName: binding.repositoryName,
      githubConnectionId: binding.githubConnectionId,
      branch: binding.branch,
    })
    if (!config) {
      throw new Error("PagerDuty live yaml is missing")
    }
    if (
      !event.serviceId ||
      !config.services.some((service) => service.id === event.serviceId)
    ) {
      return c.body(null, 200)
    }
    await runWorkflowWithWorkerWake(
      pagerdutySyncEntity.spec,
      {
        orgId: connection.orgId,
        connectionId: connection.id,
        incidentId: event.incidentId,
      },
      event.eventId
        ? {
            idempotencyKey: `pagerduty:${connection.id}:${event.eventId}`,
          }
        : undefined,
    )
  } catch (error) {
    getLogger().error(
      error instanceof Error ? error : new Error(String(error)),
      {
        step: "pagerdutySyncEntity.webhook",
        incidentId: event.incidentId,
      },
    )
    return c.json({ error: "Failed to enqueue PagerDuty sync" }, 503)
  }

  return c.body(null, 200)
}

export function registerPagerdutyWebhookRoute(app: OpenAPIHono<AppEnv>) {
  app.post("/api/v1/webhook/pagerduty", (c) => handlePagerdutyWebhook(c))
}
