import type { OpenAPIHono } from "@hono/zod-openapi"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../../app/env.js"
import { parseNotionConnectionConfig } from "../../../lib/connection-config.js"
import { decryptConnectionSecret } from "../../../lib/connection-secrets.js"
import {
  hasValidNotionSignature,
  notionConnectionHasOauthApp,
  notionProvisioningTokenMatches,
  resolveNotionWebhookSecret,
} from "../../../lib/notion-oauth.js"
import {
  getNotionConnectionRowById,
  listNotionConnectionsForWebhook,
  persistNotionWebhookSecret,
} from "../../../models/notion-connector.js"
import { getLogger } from "../../../observability/logger.js"
import { noteResolvedWebhookConnection } from "../../../observability/webhookAttribution.js"
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

async function handleProvisioning(
  c: Context<AppEnv>,
  verificationToken: string,
) {
  const env = c.var.env
  const connectionId = c.req.query("connectionId")
  const supplied = c.req.query("provisioningToken")

  if (connectionId) {
    const row = await getNotionConnectionRowById(connectionId)
    if (!row) return c.json({ error: "Unauthorized" }, 401)
    const stored = parseNotionConnectionConfig(
      row.config as Record<string, unknown>,
    )
    if (!notionConnectionHasOauthApp(stored) || !stored.oauthClientSecretEnc) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const clientSecret = decryptConnectionSecret(
      stored.oauthClientSecretEnc,
      env,
    )
    if (!supplied || !notionProvisioningTokenMatches(clientSecret, supplied)) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const persisted = await persistNotionWebhookSecret({
      connectionId,
      env,
      verificationToken,
    })
    if (persisted === "conflict") {
      return c.json({ error: "Notion webhook secret already configured" }, 409)
    }
    if (persisted === "not_found") {
      return c.json({ error: "Unauthorized" }, 401)
    }
    getLogger().info("notion_webhook_verification", {
      step: "notion.webhook.verification",
      connectionId,
      message: "Notion webhook verification token stored on the connection row",
    })
    return c.json({ verified: true }, 200)
  }

  const clientSecret = env.NOTION_CLIENT_SECRET
  if (
    !clientSecret ||
    !supplied ||
    !notionProvisioningTokenMatches(clientSecret, supplied)
  ) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  const webhookSecret = env.NOTION_WEBHOOK_SECRET
  if (webhookSecret && webhookSecret !== verificationToken) {
    return c.json({ error: "Notion webhook secret already configured" }, 409)
  }
  getLogger().info("notion_webhook_verification", {
    step: "notion.webhook.verification",
    message: webhookSecret
      ? "Notion webhook verification token matches configured NOTION_WEBHOOK_SECRET"
      : "Notion webhook verification received; set NOTION_WEBHOOK_SECRET from the Notion developer UI (or first delivery) to enable signed events",
  })
  return c.json({ verified: true }, 200)
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

  const verificationToken = parsed.data.verification_token
  if (verificationToken) {
    return handleProvisioning(c, verificationToken)
  }

  const envSecret = c.var.env.NOTION_WEBHOOK_SECRET
  const signature = c.req.header("x-notion-signature")

  if (!parsed.data.workspace_id && !parsed.data.integration_id) {
    if (!envSecret) {
      return c.json({ error: "Notion webhook secret not configured" }, 503)
    }
    if (!hasValidNotionSignature(rawBody, signature, envSecret)) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    return c.body(null, 204)
  }

  const candidates = await listNotionConnectionsForWebhook({
    integrationId: parsed.data.integration_id,
    workspaceId: parsed.data.workspace_id,
    env: c.var.env,
  })

  const accepted = candidates.filter((candidate) => {
    const secret = resolveNotionWebhookSecret(candidate.stored, c.var.env)
    return (
      Boolean(secret) &&
      hasValidNotionSignature(rawBody, signature, secret as string)
    )
  })

  if (accepted.length === 0) {
    const anySecret =
      Boolean(envSecret) ||
      candidates.some((candidate) => candidate.stored.webhookSecretEnc)
    if (!anySecret) {
      return c.json({ error: "Notion webhook secret not configured" }, 503)
    }
    return c.json({ error: "Unauthorized" }, 401)
  }

  for (const candidate of accepted) {
    noteResolvedWebhookConnection({
      orgId: candidate.connection.orgId,
      connectionId: candidate.connection.id,
    })
  }

  const eventType = parsed.data.type ?? ""
  const entityTarget = notionEntityTargetForEvent({
    type: eventType,
    entity: parsed.data.entity,
  })
  if (!entityTarget) {
    return c.body(null, 204)
  }

  const liveConnections = accepted
    .map((candidate) => candidate.connection)
    .filter(
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
