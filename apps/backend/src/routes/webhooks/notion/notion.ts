import { createHmac, timingSafeEqual } from "node:crypto"
import type { OpenAPIHono } from "@hono/zod-openapi"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../../app/env.js"
import { listNotionConnectionsForWebhook } from "../../../models/notion-connector.js"
import { getLogger } from "../../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../../../openworkflow/client.js"
import { notionSyncEntity } from "../../../openworkflow/workflows/notion-sync-entity.js"
import type { NotionEntityChange } from "../../../services/notion/incremental.js"

const notionWebhookPayloadSchema = z.object({
  id: z.string().optional(),
  verification_token: z.string().min(1).optional(),
  integration_id: z.string().optional(),
  workspace_id: z.string().optional(),
  type: z.string().optional(),
  entity: z.object({ id: z.string(), type: z.string() }).optional(),
})

const NOTION_WEBHOOK_PROVISIONING_CONTEXT =
  "ctxpipe:notion-webhook-provisioning:v1"

function hasValidProvisioningToken(c: Context<AppEnv>): boolean {
  const clientSecret = c.var.env.NOTION_CLIENT_SECRET
  const supplied = c.req.query("provisioningToken")
  if (!clientSecret || !supplied) return false

  // Notion's initial verification request is unsigned. Bind it to a URL token
  // derived from the OAuth app secret so an arbitrary first caller cannot claim
  // the webhook signing token without exposing the OAuth secret itself.
  const expected = createHmac("sha256", clientSecret)
    .update(NOTION_WEBHOOK_PROVISIONING_CONTEXT)
    .digest("base64url")
  if (supplied.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
}

function hasValidNotionSignature(
  rawBody: string,
  signature: string | undefined,
  verificationToken: string,
): boolean {
  if (!signature?.startsWith("sha256=")) return false
  const expected = `sha256=${createHmac("sha256", verificationToken)
    .update(rawBody)
    .digest("hex")}`
  if (signature.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

/**
 * Map a Notion webhook event to a single entity-scoped change. `data_source.*`
 * events describe the queryable table behind a database (Notion's 2025+ model);
 * they map onto the same `database` resource stored in `notion/config.yaml`, so
 * they are forwarded as `data_source` and re-mirror that database. `database.*`
 * (container-level) events are forwarded as `database`. Deletions map to a
 * delete action; every other lifecycle event (created/updated/moved/undeleted/…)
 * re-mirrors the affected resource.
 */
export function notionEntityTargetForEvent(input: {
  type: string | undefined
  entity: { id: string; type: string } | undefined
}): NotionEntityChange | undefined {
  const type = input.type
  const externalId = input.entity?.id
  if (!type || !externalId) return undefined
  const action: NotionEntityChange["action"] = type.endsWith(".deleted")
    ? "delete"
    : "upsert"
  if (type.startsWith("page.")) {
    return { entityType: "page", externalId, action }
  }
  if (type.startsWith("data_source.")) {
    return { entityType: "data_source", externalId, action }
  }
  if (type.startsWith("database.")) {
    return { entityType: "database", externalId, action }
  }
  return undefined
}

async function enqueueNotionEntitySync(input: {
  orgId: string
  connectionId: string
  entity: NotionEntityChange
  eventId?: string
}) {
  await runWorkflowWithWorkerWake(
    notionSyncEntity.spec,
    {
      orgId: input.orgId,
      connectionId: input.connectionId,
      entityType: input.entity.entityType,
      externalId: input.entity.externalId,
      action: input.entity.action,
      eventId: input.eventId,
    },
    input.eventId
      ? { idempotencyKey: `notion:${input.connectionId}:${input.eventId}` }
      : undefined,
  )
}

async function handleNotionWebhook(c: Context<AppEnv>) {
  const rawBody = await c.req.raw.text()
  let payload: unknown
  try {
    payload = JSON.parse(rawBody) as unknown
  } catch {
    return c.json({ error: "Bad request" }, 400)
  }
  const parsed = notionWebhookPayloadSchema.safeParse(payload)
  if (!parsed.success) return c.json({ error: "Bad request" }, 400)

  const webhookSecret = c.var.env.NOTION_WEBHOOK_SECRET

  const verificationToken = parsed.data.verification_token
  if (verificationToken) {
    if (!hasValidProvisioningToken(c)) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    // The signing secret lives in env (NOTION_WEBHOOK_SECRET), not the DB. If it
    // is already set to a different value, refuse to silently accept a new one.
    if (webhookSecret && webhookSecret !== verificationToken) {
      return c.json({ error: "Notion webhook secret already configured" }, 409)
    }
    getLogger().info("notion_webhook_verification", {
      step: "notion.webhook.verification",
      message: webhookSecret
        ? "Notion webhook verification token matches configured NOTION_WEBHOOK_SECRET"
        : "Notion webhook verification received; set NOTION_WEBHOOK_SECRET from the Notion developer UI (or first delivery) to enable signed events",
    })
    // Always 200 so Notion activates the subscription; signed events will 503
    // until the operator sets NOTION_WEBHOOK_SECRET.
    return c.json({ verified: true }, 200)
  }

  // Signed events require the operator-provisioned signing secret from env.
  if (!webhookSecret) {
    return c.json({ error: "Notion webhook secret not configured" }, 503)
  }
  if (
    !hasValidNotionSignature(
      rawBody,
      c.req.header("x-notion-signature"),
      webhookSecret,
    )
  ) {
    return c.json({ error: "Unauthorized" }, 401)
  }

  if (!parsed.data.workspace_id && !parsed.data.integration_id) {
    return c.body(null, 204)
  }

  const connections = await listNotionConnectionsForWebhook({
    integrationId: parsed.data.integration_id,
    workspaceId: parsed.data.workspace_id,
    env: c.var.env,
  })
  if (connections.length === 0) return c.body(null, 204)

  const eventType = parsed.data.type ?? ""
  // Only live entity events drive incremental sync; drop everything else.
  const entityTarget = notionEntityTargetForEvent({
    type: eventType,
    entity: parsed.data.entity,
  })
  if (!entityTarget) {
    return c.body(null, 204)
  }

  // Binding (repo/branch/phase) lives on connections.config — no sync-targets table.
  const liveConnections = connections.filter(
    (connection) =>
      Boolean(connection.repositoryId) &&
      connection.enabled &&
      connection.setupPhase === "live",
  )
  if (liveConnections.length === 0) return c.body(null, 204)

  try {
    await Promise.all(
      liveConnections.map((connection) =>
        enqueueNotionEntitySync({
          orgId: connection.orgId,
          connectionId: connection.id,
          entity: entityTarget,
          eventId: parsed.data.id,
        }),
      ),
    )
  } catch (error) {
    getLogger().error(
      error instanceof Error ? error : new Error(String(error)),
      {
        step: "notionSyncEntity.webhook",
        connectionIds: liveConnections.map((connection) => connection.id),
        entityId: entityTarget.externalId,
        entityType: entityTarget.entityType,
        eventType,
      },
    )
    return c.json({ error: "Failed to enqueue Notion sync" }, 503)
  }

  return c.body(null, 200)
}

export function registerNotionWebhookRoute(app: OpenAPIHono<AppEnv>) {
  app.post("/api/v1/webhook/notion", (c) => handleNotionWebhook(c))
}
