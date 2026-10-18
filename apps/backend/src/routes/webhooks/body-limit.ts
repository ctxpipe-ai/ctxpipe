import type { MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { AppEnv } from "../../app/env.js"

const MiB = 1024 * 1024

/**
 * The largest webhook body that each provider kind can send to ctx|. Each
 * value is above the largest real payload of that provider.
 */
export const WEBHOOK_BODY_LIMIT_BYTES = {
  /**
   * GitHub caps a webhook payload at 25 MB and does not send a larger one
   * (GitHub docs, "Webhook events and payloads").
   */
  github: 25 * MiB,
  /**
   * One Events API envelope holds one event. Slack cuts message text at
   * 40,000 characters, and a message holds at most 50 blocks.
   */
  slack: 1 * MiB,
  /**
   * Linear sends the full changed entity (`data` and `updatedFrom`) and
   * gives no maximum. An issue description is the largest field, so this
   * value is larger than the others.
   */
  linear: 5 * MiB,
  /**
   * A Notion webhook event holds ids and the names of changed properties,
   * not the page content.
   */
  notion: 1 * MiB,
  /** A PagerDuty V3 webhook event holds one incident summary. */
  pagerduty: 1 * MiB,
  /**
   * The Forge route reads only the event envelope (`eventType`), and the
   * token refresh route reads only headers.
   */
  atlassianForge: 1 * MiB,
} as const

/**
 * Reject a webhook body above `maxSize` with 413 before the handler reads
 * it. With `Content-Length`, the check reads no body. A chunked body stops
 * when it passes the limit. The handler gets the same raw bytes, so a
 * signature check still works.
 */
export function webhookBodyLimit(maxSize: number): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: "Payload too large" }, 413),
  })
}
