import { createHmac } from "node:crypto"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { OpenAPIHono } from "@hono/zod-openapi"
import { config } from "dotenv"
import { createLogger } from "evlog"
import { contextStorage } from "hono/context-storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { closeDb, initDb } from "../../db/client.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local") })

let env: ReturnType<typeof parseEnv>
let registerWebhookRoutes: typeof import("../webhooks.js").registerWebhookRoutes

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
  // The secrets are set, so each handler gets past its configuration check
  // and reads the body. A 413 thus comes only from the body limit.
  env = parseEnv({
    ...process.env,
    GITHUB_WEBHOOK_SECRET: "github-secret",
    SLACK_SIGNING_SECRET: "slack-secret",
    LINEAR_WEBHOOK_SECRET: "linear-secret",
    NOTION_WEBHOOK_SECRET: "notion-secret",
  })
  // Loaded after DATABASE_URL is checked: the OpenWorkflow client connects
  // on import.
  ;({ registerWebhookRoutes } = await import("../webhooks.js"))
})

afterAll(async () => {
  await closeDb()
})

function createTestApp() {
  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  app.use("*", async (c, next) => {
    c.set("env", env)
    c.set("log", createLogger())
    await next()
  })
  registerWebhookRoutes(app)
  return app
}

/**
 * A body of `size` bytes in chunks of 64 KiB. `pulled` counts the bytes
 * that the server read from it.
 */
function countingBody(size: number) {
  const chunk = new Uint8Array(64 * 1024).fill(0x20)
  const counter = { pulled: 0 }
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (counter.pulled >= size) {
        controller.close()
        return
      }
      const part = chunk.subarray(
        0,
        Math.min(chunk.length, size - counter.pulled),
      )
      counter.pulled += part.length
      controller.enqueue(part)
    },
  })
  return { stream, counter }
}

/** A POST init with a stream body. A stream body needs `duplex: "half"`. */
function streamPost(
  headers: Record<string, string>,
  body: ReadableStream<Uint8Array>,
): RequestInit {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers,
    body,
    duplex: "half",
  }
  return init
}

const MiB = 1024 * 1024

// Each route with its limit and the headers that let its handler go to the
// body read and then to a connection lookup or a signature check. The two
// Atlassian routes refuse the bearer token before they read the body, so
// for them "reads none" does not prove the order; the 413 still does.
const routes: Array<{
  path: string
  limit: number
  headers: Record<string, string>
}> = [
  {
    path: "/api/v1/webhook/github/con_limit_test",
    limit: 25 * MiB,
    headers: { "x-hub-signature-256": "sha256=00", "x-github-event": "push" },
  },
  {
    path: "/api/v1/webhook/github",
    limit: 25 * MiB,
    headers: { "x-hub-signature-256": "sha256=00", "x-github-event": "push" },
  },
  {
    path: "/api/v1/webhook/slack",
    limit: 1 * MiB,
    headers: {
      "x-slack-signature": "v0=00",
      "x-slack-request-timestamp": "1",
    },
  },
  {
    path: "/api/v1/webhook/linear",
    limit: 5 * MiB,
    headers: { "linear-signature": "00", "linear-timestamp": "1" },
  },
  {
    path: "/api/v1/webhook/notion",
    limit: 1 * MiB,
    headers: { "x-notion-signature": "sha256=00" },
  },
  {
    path: "/api/v1/webhook/pagerduty",
    limit: 1 * MiB,
    headers: {
      "x-pagerduty-subscription": "PSUB001",
      "x-pagerduty-signature": "v1=00",
    },
  },
  {
    path: "/api/v1/webhook/buildkite/con_limit_test",
    limit: 5 * MiB,
    headers: {
      "x-buildkite-signature": "timestamp=1,signature=00",
      "x-buildkite-event": "build.finished",
    },
  },
  {
    path: "/api/v1/webhook/plain/con_limit_test",
    limit: 5 * MiB,
    headers: { "x-ctxpipe-webhook-token": "00" },
  },
  {
    path: "/api/v1/webhook/zendesk/con_limit_test",
    limit: 1 * MiB,
    headers: {
      "x-zendesk-webhook-signature": "00",
      "x-zendesk-webhook-signature-timestamp": "1",
    },
  },
  {
    path: "/api/v1/webhook/atlassian/forge",
    limit: 1 * MiB,
    headers: { authorization: "Bearer not-a-token" },
  },
  {
    path: "/api/v1/webhook/atlassian/forge/token-refresh",
    limit: 1 * MiB,
    headers: { authorization: "Bearer not-a-token" },
  },
]

describe("webhook body limit", () => {
  it.each(routes)(
    "$path rejects a body above the declared length with 413 and reads none of it",
    async ({ path, limit, headers }) => {
      const app = createTestApp()
      const { stream, counter } = countingBody(limit + 1)
      const res = await app.request(
        path,
        streamPost(
          {
            ...headers,
            "content-type": "application/json",
            "content-length": String(limit + 1),
          },
          stream,
        ),
      )

      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({ error: "Payload too large" })
      // The handler did not run: it reads the full body before the
      // signature check, and some handlers read the database first. The
      // stream gives one chunk before the first read, so a read of the body
      // would pull more than one chunk.
      expect(counter.pulled).toBeLessThanOrEqual(64 * 1024)
    },
  )

  it("rejects a chunked body with 413 when it passes the limit", async () => {
    const app = createTestApp()
    const size = 2 * MiB
    const { stream, counter } = countingBody(size)
    const res = await app.request(
      "/api/v1/webhook/slack",
      streamPost(
        {
          "content-type": "application/json",
          "transfer-encoding": "chunked",
          "x-slack-signature": "v0=00",
          "x-slack-request-timestamp": "1",
        },
        stream,
      ),
    )

    expect(res.status).toBe(413)
    expect(counter.pulled).toBeLessThan(size)
  })

  it("keeps the raw body for the signature check below the limit", async () => {
    const app = createTestApp()
    const body = JSON.stringify({ type: "url_verification", challenge: "c1" })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = `v0=${createHmac("sha256", "slack-secret")
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    })
    const res = await app.request(
      "/api/v1/webhook/slack",
      streamPost(
        {
          "content-type": "application/json",
          "transfer-encoding": "chunked",
          "x-slack-signature": signature,
          "x-slack-request-timestamp": timestamp,
        },
        stream,
      ),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ challenge: "c1" })
  })
})
