import { createHmac, timingSafeEqual } from "node:crypto"
import type { OpenAPIHono } from "@hono/zod-openapi"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../../app/env.js"
import {
  getNotionConnectionForWebhook,
  getNotionWebhookVerificationToken,
  listNotionConnectionsForWebhook,
  storeNotionWebhookVerificationConfig,
  updateNotionWebhookVerificationToken,
} from "../../../models/notion-connector.js"
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

async function handleNotionWebhook(
  c: Context<AppEnv>,
  options: { legacyConnectionId?: string } = {},
) {
  const rawBody = await c.req.raw.text()
  let payload: unknown
  try {
    payload = JSON.parse(rawBody) as unknown
  } catch {
    return c.json({ error: "Bad request" }, 400)
  }
  const parsed = notionWebhookPayloadSchema.safeParse(payload)
  if (!parsed.success) return c.json({ error: "Bad request" }, 400)

  const verificationToken = parsed.data.verification_token
  if (verificationToken) {
    if (!hasValidProvisioningToken(c)) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    if (options.legacyConnectionId) {
      const connection = await getNotionConnectionForWebhook(
        options.legacyConnectionId,
      )
      if (!connection)
        return c.json({ error: "Unknown Notion connection" }, 404)
      await updateNotionWebhookVerificationToken({
        orgId: connection.orgId,
        connectionId: connection.id,
        verificationToken,
      })
    } else {
      await storeNotionWebhookVerificationConfig(
        verificationToken,
        parsed.data.integration_id ?? null,
      )
    }
    return c.json({ verified: true }, 200)
  }

  if (
    !options.legacyConnectionId &&
    !parsed.data.workspace_id &&
    !parsed.data.integration_id
  ) {
    return c.body(null, 204)
  }

  const connections = options.legacyConnectionId
    ? [await getNotionConnectionForWebhook(options.legacyConnectionId)].filter(
        (connection): connection is NonNullable<typeof connection> =>
          Boolean(connection),
      )
    : await listNotionConnectionsForWebhook({
        integrationId: parsed.data.integration_id,
        workspaceId: parsed.data.workspace_id,
      })
  if (connections.length === 0) return c.body(null, 204)

  if (
    options.legacyConnectionId &&
    parsed.data.workspace_id &&
    connections[0]?.workspaceId &&
    connections[0].workspaceId !== parsed.data.workspace_id
  ) {
    return c.json({ error: "Unauthorized" }, 401)
  }

  const appVerificationToken = await getNotionWebhookVerificationToken()
  const verificationTokenForSignature =
    appVerificationToken ??
    connections.find((connection) => connection.webhookVerificationToken)
      ?.webhookVerificationToken
  if (
    !verificationTokenForSignature ||
    !hasValidNotionSignature(
      rawBody,
      c.req.header("x-notion-signature"),
      verificationTokenForSignature,
    )
  ) {
    return c.json({ error: "Unauthorized" }, 401)
  }

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
  // Keep the old URL working for subscriptions already created from the draft PR.
  app.post("/api/v1/webhook/notion/:connectionId", (c) =>
    handleNotionWebhook(c, { legacyConnectionId: c.req.param("connectionId") }),
  )
}
