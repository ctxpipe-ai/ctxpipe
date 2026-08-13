import type { OpenAPIHono } from "@hono/zod-openapi"
import { z } from "zod"
import type { AppEnv } from "../../../app/env.js"
import {
  getSlackSyncTargetByConnectionId,
  listSlackConnectionsByTeamId,
} from "../../../models/slack-connector.js"
import { getLogger } from "../../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../../../openworkflow/client.js"
import { slackCaptureThread } from "../../../openworkflow/workflows/slack-capture-thread.js"
import { verifySlackRequestSignature } from "../../../services/slack/verify-signature.js"

const SlackEventEnvelopeSchema = z.object({
  type: z.string(),
  challenge: z.string().optional(),
  team_id: z.string().optional(),
  event_id: z.string().optional(),
  event: z
    .object({
      type: z.string(),
      channel: z.string().optional(),
      ts: z.string().optional(),
      thread_ts: z.string().optional(),
    })
    .passthrough()
    .optional(),
})

export function registerSlackWebhookRoute(app: OpenAPIHono<AppEnv>) {
  app.post("/api/v1/webhook/slack", async (c) => {
    const env = c.var.env
    const signingSecret = env.SLACK_SIGNING_SECRET
    if (!signingSecret) {
      getLogger().warn("slack_webhook_signing_secret_missing")
      return c.json({ error: "Slack webhook not configured" }, 503)
    }

    const rawBody = await c.req.raw.text()
    const valid = verifySlackRequestSignature({
      signingSecret,
      signatureHeader: c.req.header("x-slack-signature") ?? undefined,
      timestampHeader: c.req.header("x-slack-request-timestamp") ?? undefined,
      rawBody,
    })
    if (!valid) {
      return c.json({ error: "Invalid Slack signature" }, 401)
    }

    let payload: unknown
    try {
      payload = JSON.parse(rawBody) as unknown
    } catch {
      return c.json({ error: "Invalid JSON" }, 400)
    }

    const parsed = SlackEventEnvelopeSchema.safeParse(payload)
    if (!parsed.success) {
      return c.json({ error: "Invalid Slack event payload" }, 400)
    }

    if (parsed.data.type === "url_verification") {
      if (!parsed.data.challenge) {
        return c.json({ error: "Missing challenge" }, 400)
      }
      return c.json({ challenge: parsed.data.challenge }, 200)
    }

    if (parsed.data.type !== "event_callback" || !parsed.data.event) {
      return c.json({ ok: true }, 200)
    }

    // v1 ingest is intent capture only: `app_mention` triggers a thread
    // snapshot. There is no channel mirror, so other event types are ignored
    // (ADR-024 §3).
    const event = parsed.data.event
    if (event.type !== "app_mention") {
      return c.json({ ok: true }, 200)
    }

    const teamId = parsed.data.team_id
    const channelId = event.channel
    const mentionTs = event.ts
    // The mentioned message is treated as the thread root when it has no
    // thread of its own (ADR-024 §3).
    const threadTs = event.thread_ts ?? mentionTs
    if (!teamId || !channelId || !threadTs || !mentionTs) {
      return c.json({ ok: true }, 200)
    }

    const connections = await listSlackConnectionsByTeamId(teamId)
    if (connections.length === 0) {
      getLogger().info("slack_webhook_unknown_team", { teamId })
      return c.json({ ok: true }, 200)
    }

    for (const connection of connections) {
      const target = await getSlackSyncTargetByConnectionId(connection.id)
      if (
        !target ||
        target.orgId !== connection.orgId ||
        !target.enabled ||
        target.setupPhase !== "live"
      ) {
        continue
      }

      void runWorkflowWithWorkerWake(
        slackCaptureThread.spec,
        {
          orgId: connection.orgId,
          connectionId: connection.id,
          channelId,
          threadTs,
        },
        {
          // Mention ts (not thread root) so a later @ recaptures; Slack
          // retries reuse the same event ts and still dedupe (ADR-024 §4).
          idempotencyKey: `slack-capture:${connection.id}:${channelId}:${threadTs}:${mentionTs}`,
        },
      ).catch((err: unknown) => {
        getLogger().error(err instanceof Error ? err : new Error(String(err)), {
          step: "slack_capture_thread.enqueue",
          connectionId: connection.id,
        })
      })

      getLogger().info("slack_capture_thread_enqueued", {
        connectionId: connection.id,
        channelId,
        threadTs,
        eventId: parsed.data.event_id,
      })
    }

    return c.json({ ok: true }, 200)
  })
}
