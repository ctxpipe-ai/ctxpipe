import { crc32 } from "node:zlib"
import { chat } from "@tanstack/ai"
import { HttpResponse, http } from "msw"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useMswServer } from "../../../test/msw.js"
import { bedrockModelProvider } from "../../retrieval/services/providers/bedrockModelProvider.js"
import { handleBedrockChatCompletion } from "./bedrockOpenAiProxy.js"

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest owns this MSW lifecycle.
const server = useMswServer()
afterEach(() => vi.unstubAllEnvs())

const converseUrl = (model: string) =>
  `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(model)}/converse`
const streamUrl = (model: string) => `${converseUrl(model)}-stream`

const env = {
  MODEL_BEDROCK_AWS_REGION: "us-east-1",
  MODEL_FAST_NAME:
    "fast-model?sampling.maxTokens=50&sampling.topP=0.9&reasoning.effort=low",
} as never

function stubAwsCredentials() {
  vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-access")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-secret")
}

/** One binary `application/vnd.amazon.eventstream` frame, as ConverseStream sends it. */
function eventStreamFrame(
  eventType: string,
  payload: unknown,
): Uint8Array<ArrayBuffer> {
  const text = new TextEncoder()
  const header = (name: string, value: string) => {
    const n = text.encode(name)
    const v = text.encode(value)
    const out = new Uint8Array(1 + n.length + 1 + 2 + v.length)
    const view = new DataView(out.buffer)
    out[0] = n.length
    out.set(n, 1)
    out[1 + n.length] = 7
    view.setUint16(2 + n.length, v.length)
    out.set(v, 4 + n.length)
    return out
  }
  const headers = [
    header(":event-type", eventType),
    header(":content-type", "application/json"),
    header(":message-type", "event"),
  ]
  const headersLength = headers.reduce((sum, h) => sum + h.length, 0)
  const body = text.encode(JSON.stringify(payload))
  const total = 12 + headersLength + body.length + 4
  const frame = new Uint8Array(total)
  const view = new DataView(frame.buffer)
  view.setUint32(0, total)
  view.setUint32(4, headersLength)
  view.setUint32(8, crc32(frame.subarray(0, 8)))
  let offset = 12
  for (const h of headers) {
    frame.set(h, offset)
    offset += h.length
  }
  frame.set(body, offset)
  view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)))
  return frame
}

describe("handleBedrockChatCompletion", () => {
  it.each([
    "end_turn",
    "max_tokens",
  ])("answers a non-streaming request with stop reason %s", async (stopReason) => {
    stubAwsCredentials()
    let sent: Record<string, unknown> = {}
    server.use(
      http.post(converseUrl("fast-model"), async ({ request }) => {
        expect(request.headers.get("authorization")).toContain(
          "AWS4-HMAC-SHA256",
        )
        sent = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({
          output: {
            message: {
              role: "assistant",
              content: [{ text: "Hello " }, { text: "there" }],
            },
          },
          stopReason,
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
          metrics: { latencyMs: 1 },
        })
      }),
    )
    const response = await handleBedrockChatCompletion(env, {
      model: "fast-model",
      temperature: 0.3,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" },
        { role: "user", content: "again" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "last" },
      ],
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      object: string
      model: string
      choices: Array<{ message: { role: string; content: string } }>
    }
    expect(body).toMatchObject({
      object: "chat.completion",
      model: "fast-model",
      choices: [
        {
          message: { role: "assistant", content: "Hello there" },
          finish_reason: stopReason === "max_tokens" ? "length" : "stop",
        },
      ],
    })
    expect(sent).toMatchObject({
      system: [{ text: "Be brief." }],
      messages: [
        { role: "user", content: [{ text: "hi" }, { text: "again" }] },
        { role: "assistant", content: [{ text: "hello" }] },
        { role: "user", content: [{ text: "last" }] },
      ],
      inferenceConfig: { temperature: 0.3, maxTokens: 50, topP: 0.9 },
      additionalModelRequestFields: { reasoning_effort: "low" },
    })
  })

  it.each([
    "end_turn",
    "max_tokens",
  ])("streams text and the final stop reason %s", async (stopReason) => {
    stubAwsCredentials()
    server.use(
      http.post(
        streamUrl("fast-model"),
        () =>
          new HttpResponse(
            new Blob([
              eventStreamFrame("messageStart", { role: "assistant" }),
              eventStreamFrame("contentBlockDelta", {
                contentBlockIndex: 0,
                delta: { text: "Hel" },
              }),
              eventStreamFrame("contentBlockDelta", {
                contentBlockIndex: 0,
                delta: { text: "lo" },
              }),
              eventStreamFrame("contentBlockStop", { contentBlockIndex: 0 }),
              eventStreamFrame("messageStop", { stopReason }),
            ]),
            {
              headers: { "content-type": "application/vnd.amazon.eventstream" },
            },
          ),
      ),
    )
    const response = await handleBedrockChatCompletion(env, {
      model: "fast-model",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const events = (await response.text())
      .split("\n\n")
      .filter(Boolean)
      .map((line) => line.replace(/^data: /, ""))
    expect(events.at(-1)).toBe("[DONE]")
    expect(JSON.parse(events.at(-2) ?? "null")).toMatchObject({
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: stopReason === "max_tokens" ? "length" : "stop",
        },
      ],
    })
    const deltas = events.slice(0, -2).map(
      (json) =>
        JSON.parse(json) as {
          object: string
          choices: Array<{ delta: { content: string } }>
        },
    )
    expect(deltas.map((chunk) => chunk.object)).toEqual([
      "chat.completion.chunk",
      "chat.completion.chunk",
    ])
    expect(deltas.map((chunk) => chunk.choices[0]?.delta.content)).toEqual([
      "Hel",
      "lo",
    ])
  })

  it("rejects a request without a model", async () => {
    const response = await handleBedrockChatCompletion(env, {
      messages: [{ role: "user", content: "hi" }],
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "model is required",
    })
  })

  it("rejects when Bedrock refuses the request", async () => {
    stubAwsCredentials()
    server.use(
      http.post(converseUrl("fast-model"), () =>
        HttpResponse.json(
          { message: "Invalid request" },
          {
            status: 400,
            headers: { "x-amzn-errortype": "ValidationException" },
          },
        ),
      ),
    )
    await expect(
      handleBedrockChatCompletion(env, {
        model: "fast-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow()
  })
})

it("merges consecutive roles through the host provider", async () => {
  stubAwsCredentials()
  let sent: unknown
  server.use(
    http.post(converseUrl("fast-model"), async ({ request }) => {
      sent = await request.json()
      return HttpResponse.json({
        output: { message: { role: "assistant", content: [{ text: "ok" }] } },
        stopReason: "end_turn",
      })
    }),
  )
  const { chat: adapter } = bedrockModelProvider({
    models: ["fast-model"],
    apiKey: "",
    env: { MODEL_BEDROCK_AWS_REGION: "us-east-1" },
    temperature: 0.2,
    modelParams: { sampling: { maxTokens: 20, topP: 0.8 } },
  })
  expect(
    await chat({
      adapter,
      stream: false,
      systemPrompts: ["Be brief."],
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
        { role: "assistant", content: "answer" },
        { role: "assistant", content: "more" },
      ],
    }),
  ).toBe("ok")
  expect(sent).toMatchObject({
    system: [{ text: "Be brief." }],
    messages: [
      { role: "user", content: [{ text: "first" }, { text: "second" }] },
      { role: "assistant", content: [{ text: "answer" }, { text: "more" }] },
    ],
    inferenceConfig: { temperature: 0.2, maxTokens: 20, topP: 0.8 },
  })
})

it.each([
  false,
  true,
])("rejects an aborted request (stream=%s)", async (stream) => {
  stubAwsCredentials()
  server.use(
    http.post(
      stream ? streamUrl("fast-model") : converseUrl("fast-model"),
      () => HttpResponse.json({}),
    ),
  )
  await expect(
    handleBedrockChatCompletion(
      env,
      {
        model: "fast-model",
        stream,
        messages: [{ role: "user", content: "hi" }],
      },
      AbortSignal.abort(),
    ),
  ).rejects.toMatchObject({ name: "AbortError" })
})
