import type { OpenAPIHono } from "@hono/zod-openapi"
import { z } from "zod"
import type { AppEnv } from "../../../app/env.js"
import {
  getSlackConnectionByTeamId,
  getSlackSyncTargetByConnectionId,
  revokeSlackConnectionByTeamId,
} from "../../../models/slack-connector.js"
import { getLogger } from "../../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../../../openworkflow/client.js"
import { slackMentionAgent } from "../../../openworkflow/workflows/slack-mention-agent.js"
import {
  publishSlackMentionStatus,
  SLACK_MENTION_STATUS_ENQUEUE_FAILED,
  SLACK_MENTION_STATUS_NEEDS_THREAD,
} from "../../../services/slack/mention-status.js"
import { verifySlackRequestSignature } from "../../../services/slack/verify-signature.js"

const SlackEventEnvelopeSchema = z.object({
  type: z.string(),
  challenge: z.string().optional(),
  api_app_id: z.string().optional(),
  team_id: z.string().optional(),
  event_id: z.string().optional(),
  event: z
    .object({
      type: z.string(),
      channel: z.string().optional(),
      channel_type: z.string().optional(),
      ts: z.string().optional(),
      thread_ts: z.string().optional(),
      text: z.string().optional(),
      user: z.string().optional(),
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

    const event = parsed.data.event
    const teamId = parsed.data.team_id
    getLogger().info("slack_webhook_event_received", {
      apiAppId: parsed.data.api_app_id,
      teamId,
      eventType: event.type,
      eventId: parsed.data.event_id,
    })

    if (event.type === "app_uninstalled" || event.type === "tokens_revoked") {
      if (teamId) {
        const revoked = await revokeSlackConnectionByTeamId(teamId)
        getLogger().info("slack_connection_revoked_from_event", {
          teamId,
          eventType: event.type,
          revoked,
        })
      }
      return c.json({ ok: true }, 200)
    }

    // v1 ingest: `app_mention` starts the mention agent (ADR-025 §3).
    if (event.type !== "app_mention") {
      return c.json({ ok: true }, 200)
    }

    if (event.channel_type === "im" || event.channel_type === "mpim") {
      getLogger().info("slack_webhook_dm_ignored", {
        teamId,
        channelType: event.channel_type,
      })
      return c.json({ ok: true }, 200)
    }

    const channelId = event.channel
    const mentionTs = event.ts
    if (!teamId || !channelId || !mentionTs) {
      return c.json({ ok: true }, 200)
    }

    const connection = await getSlackConnectionByTeamId(teamId)
    if (!connection) {
      getLogger().info("slack_webhook_unknown_team", { teamId })
      return c.json({ ok: true }, 200)
    }

    const target = await getSlackSyncTargetByConnectionId(connection.id)
    if (!target || target.orgId !== connection.orgId || !target.enabled) {
      getLogger().info("slack_webhook_mention_skipped_not_live", {
        connectionId: connection.id,
        teamId,
        enabled: target?.enabled ?? false,
      })
      return c.json({ ok: true }, 200)
    }

    // Channel-top-level mentions have no `thread_ts`. Collapsing to mention ts
    // would snapshot only the invocation. Capture requires an existing thread
    // (ADR-025 §3).
    if (!event.thread_ts) {
      getLogger().info("slack_webhook_channel_top_level_mention_refused", {
        connectionId: connection.id,
        channelId,
        mentionTs,
        eventId: parsed.data.event_id,
      })
      void publishSlackMentionStatus({
        env,
        connection,
        channelId,
        threadTs: mentionTs,
        text: SLACK_MENTION_STATUS_NEEDS_THREAD,
      })
      return c.json({ ok: true }, 200)
    }

    const threadTs = event.thread_ts

    getLogger().info("slack_webhook_app_mention", {
      connectionId: connection.id,
      channelId,
      threadTs,
      eventId: parsed.data.event_id,
    })

    // Slack Events must ACK within ~3s. Awaiting OpenWorkflow + Neon on a PR
    // preview overruns that; Slack returns 499, retries, and each retry wakes a
    // new openworkflow deploy that kills the previous worker. Enqueue after 200.
    void runWorkflowWithWorkerWake(
      slackMentionAgent.spec,
      {
        orgId: connection.orgId,
        connectionId: connection.id,
        channelId,
        threadTs,
        mentionText: event.text,
        mentionUserId: event.user,
      },
      {
        // Mention ts (not thread root) so a later @ is a new agent run;
        // Slack retries reuse the same event ts and still dedupe (ADR-025 §4).
        idempotencyKey: `slack-mention:${connection.id}:${channelId}:${threadTs}:${mentionTs}`,
      },
    )
      .then(() => {
        getLogger().info("slack_mention_agent_enqueued", {
          connectionId: connection.id,
          channelId,
          threadTs,
          eventId: parsed.data.event_id,
        })
      })
      .catch(async (err: unknown) => {
        getLogger().error(err instanceof Error ? err : new Error(String(err)), {
          step: "slack_mention_agent.enqueue",
          connectionId: connection.id,
        })
        await publishSlackMentionStatus({
          env,
          connection,
          channelId,
          threadTs,
          text: SLACK_MENTION_STATUS_ENQUEUE_FAILED,
        })
      })

    return c.json({ ok: true }, 200)
  })
}
