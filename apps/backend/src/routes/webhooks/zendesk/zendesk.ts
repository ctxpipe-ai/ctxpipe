import type { OpenAPIHono } from "@hono/zod-openapi"
import type { Context } from "hono"

import type { AppEnv } from "../../../app/env.js"
import { enqueueConnectionSourcesSync } from "../../../domain/workspace-sources/enqueue.js"
import { getZendeskWebhookTarget } from "../../../models/zendesk-connector.js"
import { getLogger } from "../../../observability/logger.js"
import { verifyZendeskWebhookSignature } from "../../../services/zendesk/signature.js"
import type { ZendeskArticleEvent } from "../../../services/zendesk/workspace-source-adapter.js"
import { noteResolvedWebhookConnections } from "../attribution.js"

/** The article events that change the files of a Help Center source. */
const ARTICLE_EVENTS = new Set([
  "zen:event-type:article.published",
  "zen:event-type:article.unpublished",
])

/**
 * Article events sync the connection at most once in this window: many
 * edits give one commit for each Workspace in each window.
 */
const SYNC_WINDOW_MS = 10 * 60 * 1000

/**
 * ctx| creates one webhook for each connection, so the URL names the
 * connection and the route verifies with that connection's secret (ADR-058).
 */
async function handleZendeskWebhook(c: Context<AppEnv>) {
  const connectionId = c.req.param("connectionId") ?? ""
  const rawBody = Buffer.from(await c.req.arrayBuffer())
  const target = await getZendeskWebhookTarget(connectionId, c.var.env)
  if (
    !target?.webhookSecret ||
    !verifyZendeskWebhookSignature({
      rawBody,
      signature: c.req.header("x-zendesk-webhook-signature"),
      timestamp: c.req.header("x-zendesk-webhook-signature-timestamp"),
      secret: target.webhookSecret,
    })
  ) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  noteResolvedWebhookConnections([{ orgId: target.orgId, id: connectionId }])

  let type: unknown
  try {
    type = (JSON.parse(rawBody.toString("utf8")) as { type?: unknown }).type
  } catch {
    return c.json({ error: "Bad request" }, 400)
  }
  if (
    typeof type !== "string" ||
    !ARTICLE_EVENTS.has(type) ||
    target.status !== "installed"
  ) {
    return c.body(null, 200)
  }

  // ADR-050: one sources sync of the connection at the end of the window. A
  // later event in the same window has the same key and queues nothing. A
  // failed enqueue returns 5xx; a later event or the daily sync gets it.
  const windowStart = Math.floor(Date.now() / SYNC_WINDOW_MS) * SYNC_WINDOW_MS
  try {
    await enqueueConnectionSourcesSync({
      orgId: target.orgId,
      connectionId,
      provider: "zendesk",
      event: { kind: "articles" } satisfies ZendeskArticleEvent,
      dedupeKey: `articles:${windowStart}`,
      availableAt: new Date(windowStart + SYNC_WINDOW_MS),
    })
  } catch (error) {
    getLogger().error(
      error instanceof Error ? error : new Error(String(error)),
      { step: "zendesk_webhook.sources", connectionId },
    )
    return c.json({ error: "Failed to enqueue Zendesk sync" }, 503)
  }
  return c.body(null, 200)
}

export function registerZendeskWebhookRoute(app: OpenAPIHono<AppEnv>) {
  app.post("/api/v1/webhook/zendesk/:connectionId", (c) =>
    handleZendeskWebhook(c),
  )
}
