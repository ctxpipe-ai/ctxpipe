import type { OpenAPIHono } from "@hono/zod-openapi"
import type { Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { AppEnv } from "../../../app/env.js"
import { enqueueConnectionSourcesSync } from "../../../domain/workspace-sources/enqueue.js"
import { getBuildkiteWebhookTarget } from "../../../models/buildkite-connector.js"
import { getLogger } from "../../../observability/logger.js"
import { verifyBuildkiteWebhookSignature } from "../../../services/buildkite/signature.js"
import { noteResolvedWebhookConnections } from "../attribution.js"

/**
 * Finished builds sync at most once in this window for each connection: a
 * busy pipeline gives one commit for each Workspace in each window, not one
 * for each build.
 */
const SYNC_WINDOW_MS = 10 * 60 * 1000

/**
 * The most bytes that the route reads from one delivery. A `build.finished`
 * body is one build with its jobs. Buildkite publishes no size limit for it,
 * so 2 MB is a safe bound that is far above a build with hundreds of jobs.
 * The limit applies before the route reads the body, so an unsigned sender
 * cannot make the backend buffer more.
 */
const MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024

/**
 * The admin adds this webhook in Buildkite with its own token, so the URL
 * names the connection, as the GitHub App webhook does (ADR-054).
 */
async function handleBuildkiteWebhook(c: Context<AppEnv>) {
  const connectionId = c.req.param("connectionId") ?? ""
  const rawBody = Buffer.from(await c.req.arrayBuffer())
  const target = await getBuildkiteWebhookTarget(connectionId, c.var.env)
  if (
    !target?.webhookToken ||
    !verifyBuildkiteWebhookSignature({
      rawBody,
      signatureHeader: c.req.header("x-buildkite-signature"),
      token: target.webhookToken,
    })
  ) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  noteResolvedWebhookConnections([{ orgId: target.orgId, id: connectionId }])

  // `ping` and the other events have nothing to sync.
  if (
    c.req.header("x-buildkite-event") !== "build.finished" ||
    target.status !== "installed"
  ) {
    return c.body(null, 200)
  }

  // ADR-050: one sources sync of the connection at the end of the window. A
  // later event in the same window has the same key and queues nothing. A
  // failed enqueue returns 5xx; a later event or the daily sync gets the build.
  const windowStart = Math.floor(Date.now() / SYNC_WINDOW_MS) * SYNC_WINDOW_MS
  try {
    await enqueueConnectionSourcesSync({
      orgId: target.orgId,
      connectionId,
      provider: "buildkite",
      dedupeKey: `builds:${windowStart}`,
      availableAt: new Date(windowStart + SYNC_WINDOW_MS),
    })
  } catch (error) {
    getLogger().error(
      error instanceof Error ? error : new Error(String(error)),
      { step: "buildkite_webhook.sources", connectionId },
    )
    return c.json({ error: "Failed to enqueue Buildkite sync" }, 503)
  }
  return c.body(null, 200)
}

export function registerBuildkiteWebhookRoute(app: OpenAPIHono<AppEnv>) {
  app.post(
    "/api/v1/webhook/buildkite/:connectionId",
    bodyLimit({
      maxSize: MAX_WEBHOOK_BODY_BYTES,
      onError: (c) => c.json({ error: "Payload too large" }, 413),
    }),
    (c) => handleBuildkiteWebhook(c),
  )
}
