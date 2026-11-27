import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { OpenAPIHono } from "@hono/zod-openapi"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { useMswServer } from "../../../test/msw.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { closeDb, initDb } from "../../db/client.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import {
  type ChatCapabilityFixture,
  seedChatCapability,
} from "../../test/workspace-chat-capability-fixture.js"
import { openaiRoutes } from "./openai.js"
import { workspaceChatOpenaiRoutes } from "./workspace-chat-openai.js"

// No file part of a chat request reaches OpenRouter (CTX-1454): both model
// proxies send the text of our converter in place of a PDF, and refuse each
// other file part.

const AUTH_SECRET = "abcdefghijklmnopqrstuvwxyz123456"
const OPENROUTER = "https://openrouter.ai/api/v1"

let received: Record<string, unknown>[] = []
useMswServer(
  http.post(`${OPENROUTER}/chat/completions`, async ({ request }) => {
    received.push((await request.json()) as Record<string, unknown>)
    return HttpResponse.json({
      id: "chatcmpl_file",
      choices: [{ message: { role: "assistant", content: "ok" } }],
    })
  }),
)

const env = parseEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost:5432/ctxpipe_test",
  AUTH_BASE_URL: "https://backend.example.com",
  AUTH_SECRET,
  PORT: "3000",
  MODEL_PROVIDER: "openrouter",
  MODEL_PROVIDER_URL: OPENROUTER,
  MODEL_PROVIDER_API_KEY: "sk-upstream",
  MODEL_FAST_NAME: "test/model-fast",
})

function app(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use("*", async (c, next) => {
    c.set("env", env)
    c.set("user", {
      id: "user_test",
      email: "test@example.com",
    } as AppEnv["Variables"]["user"])
    c.set("session", {
      id: "sess_test",
      userId: "user_test",
    } as AppEnv["Variables"]["session"])
    c.set("orgId", "org_test")
    await next()
  })
  app.route("/:orgSlug/api/v1/openai", openaiRoutes)
  app.route("/:orgSlug/api/v1/workspace-chat/openai", workspaceChatOpenaiRoutes)
  return app
}

let chat: ChatCapabilityFixture | undefined

beforeAll(async () => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for this integration test")
  initDb(process.env.DATABASE_URL)
  chat = await seedChatCapability(AUTH_SECRET)
})

afterAll(async () => {
  await chat?.cleanup()
  await closeDb()
})

const pdf = readFileSync(
  fileURLToPath(
    new URL(
      "../../knowledge-plane/fixtures/convert/sample.pdf",
      import.meta.url,
    ),
  ),
)
const filePart = (filename: string, mime: string, bytes: Buffer) => ({
  type: "file",
  file: {
    filename,
    file_data: `data:${mime};base64,${bytes.toString("base64")}`,
  },
})

const proxies = [
  { name: "the OpenAI-compatible proxy", path: "/acme/api/v1/openai" },
  {
    name: "the model proxy of the sandboxes",
    path: "/acme/api/v1/workspace-chat/openai",
  },
]

async function complete(path: string, content: unknown[]) {
  if (!chat) throw new Error("seedChatCapability did not run")
  return app().request(`${path}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await chat.mint()}`,
    },
    body: JSON.stringify({
      model: "test/model-fast",
      messages: [{ role: "user", content }],
      // The OpenRouter file parser: the proxy drops it (ADR-070).
      plugins: [{ id: "file-parser", pdf: { engine: "mistral-ocr" } }],
    }),
  })
}

describe.each(proxies)("$name", ({ path }) => {
  it("sends the text of a PDF file part, and no file part and no plugins", async () => {
    received = []
    const res = await complete(path, [
      { type: "text", text: "Summarize the file." },
      filePart("sample.pdf", "application/pdf", pdf),
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
      },
    ])
    expect(res.status).toBe(200)
    expect(received).toHaveLength(1)
    const upstream = received[0] ?? {}
    expect(upstream).not.toHaveProperty("plugins")
    const content = (
      upstream.messages as Array<{ content: Array<Record<string, unknown>> }>
    )[0]?.content
    expect(content?.map((part) => part.type)).toEqual([
      "text",
      "text",
      "image_url",
    ])
    expect(String(content?.[1]?.text)).toMatch(/^<file name="sample\.pdf">\n/)
    // The image part stays as it is.
    expect(content?.[2]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
    })
    expect(JSON.stringify(upstream)).not.toContain('"file"')
  })

  it.each([
    [
      "a file part that is not a PDF",
      filePart("notes.txt", "text/plain", Buffer.from("hello")),
      '"notes.txt" is not a PDF',
    ],
    [
      "a PDF that the converter cannot read",
      filePart("broken.pdf", "application/pdf", Buffer.from("not a pdf")),
      'The PDF "broken.pdf" cannot be converted to text',
    ],
    [
      "a malformed file part",
      {
        type: "file",
        file: {
          filename: null,
          file_data: `data:application/pdf;base64,${pdf.toString("base64")}`,
        },
      },
      "A file part is malformed",
    ],
  ])("refuses %s, and calls no model", async (_name, part, error) => {
    received = []
    const res = await complete(path, [part])
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain(error)
    expect(received).toHaveLength(0)
  })
})
