import type { OpenAPIHono } from "@hono/zod-openapi"
import { z } from "zod"
import type { AppEnv } from "../../../app/env.js"
import {
  getSlackSyncTargetByConnectionId,
  listSlackConnectionsByTeamId,
  markSlackThreadDirty,
} from "../../../models/slack-connector.js"
import { getLogger } from "../../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../../../openworkflow/client.js"
import { slackSyncFlush } from "../../../openworkflow/workflows/slack-sync-flush.js"
import { slackFlushIdempotencyBucket } from "../../../services/slack/cadence.js"
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
      subtype: z.string().optional(),
    })
    .passthrough()
    .optional(),
})

function threadTsFromEvent(event: {
  ts?: string
  thread_ts?: string
  subtype?: string
  previous_message?: { ts?: string; thread_ts?: string }
  deleted_ts?: string
}): string | undefined {
  if (event.subtype === "message_deleted") {
    return (
      event.previous_message?.thread_ts ??
      event.previous_message?.ts ??
      event.deleted_ts ??
      event.thread_ts ??
      event.ts
    )
  }
  return event.thread_ts ?? event.ts
}

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

    const event = parsed.data.event
    const teamId = parsed.data.team_id
    if (!teamId) {
      return c.json({ ok: true }, 200)
    }

    // Ignore message subtypes we do not mirror (bot noise, channel_join, etc.)
    // except message_changed / message_deleted which update/remove content.
    if (
      event.type === "message" &&
      event.subtype &&
      event.subtype !== "message_changed" &&
      event.subtype !== "message_deleted" &&
      event.subtype !== "thread_broadcast"
    ) {
      return c.json({ ok: true }, 200)
    }

    const channelId = event.channel
    const threadTs = threadTsFromEvent(
      event as {
        ts?: string
        thread_ts?: string
        subtype?: string
        previous_message?: { ts?: string; thread_ts?: string }
        deleted_ts?: string
      },
    )
    if (!channelId || !threadTs) {
      return c.json({ ok: true }, 200)
    }

    const connections = await listSlackConnectionsByTeamId(teamId)
    if (connections.length === 0) {
      getLogger().info("slack_webhook_unknown_team", { teamId })
      return c.json({ ok: true }, 200)
    }

    const bucket = slackFlushIdempotencyBucket()
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

      await markSlackThreadDirty({
        connectionId: connection.id,
        channelId,
        threadTs,
      })

      void runWorkflowWithWorkerWake(
        slackSyncFlush.spec,
        {
          orgId: connection.orgId,
          connectionId: connection.id,
        },
        {
          idempotencyKey: `slack-flush:${connection.id}:${bucket}`,
        },
      ).catch((err: unknown) => {
        getLogger().error(err instanceof Error ? err : new Error(String(err)), {
          step: "slack_sync_flush.enqueue",
          connectionId: connection.id,
        })
      })

      getLogger().info("slack_thread_marked_dirty", {
        connectionId: connection.id,
        channelId,
        threadTs,
        eventId: parsed.data.event_id,
        eventType: event.type,
        eventSubtype: event.subtype,
      })
    }

    return c.json({ ok: true }, 200)
  })
}
