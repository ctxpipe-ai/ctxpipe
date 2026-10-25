import { resourceFromAttributes } from "@opentelemetry/resources"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { chat } from "@tanstack/ai"
import { delay, HttpResponse, http } from "msw"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { useMswServer } from "../../../test/msw.js"
import { abortAfter } from "../../lib/abortAfter.js"
import { LangfuseContextSpanProcessor } from "../../observability/langfuseContextProcessor.js"
import { getModel } from "./modelProvider.js"

const server = useMswServer()
afterEach(() => vi.unstubAllEnvs())

it.each([
  "openrouter",
  "openai-like",
  "azure",
  "bedrock",
] as const)("runs a host call through TanStack with %s settings", async (provider) => {
  vi.stubEnv("MODEL_PROVIDER", provider)
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-key")
  vi.stubEnv("MODEL_PROVIDER_URL", "https://models.test/v1")
  vi.stubEnv(
    "MODEL_FAST_NAME",
    "fast?reasoning.effort=low&sampling.maxTokens=100&sampling.topP=0.8",
  )
  vi.stubEnv("MODEL_MEDIUM_NAME", "medium")
  vi.stubEnv("MODEL_HIGH_NAME", "high")
  vi.stubEnv("MODEL_BEDROCK_AWS_REGION", "us-east-1")
  vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-access")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-secret")
  let body: unknown
  server.use(
    http.post(
      provider === "bedrock"
        ? "https://bedrock-runtime.us-east-1.amazonaws.com/model/fast/converse"
        : "https://models.test/v1/chat/completions",
      async ({ request }) => {
        if (provider === "bedrock")
          expect(request.headers.get("authorization")).toContain(
            "AWS4-HMAC-SHA256",
          )
        else if (provider === "azure") {
          expect(request.headers.get("api-key")).toBe("fixture-key")
          expect(request.headers.has("authorization")).toBe(false)
        } else
          expect(request.headers.get("authorization")).toBe(
            "Bearer fixture-key",
          )
        body = await request.json()
        return HttpResponse.json(
          provider === "bedrock"
            ? {
                output: {
                  message: {
                    role: "assistant",
                    content: [{ text: "Updated knowledge" }],
                  },
                },
                stopReason: "end_turn",
                usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
                metrics: { latencyMs: 1 },
              }
            : {
                id: "reply",
                model: "fast",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: "Updated knowledge",
                    },
                    finish_reason: "stop",
                  },
                ],
                usage: {
                  prompt_tokens: 4,
                  completion_tokens: 2,
                  total_tokens: 6,
                },
              },
        )
      },
    ),
  )
  const result = await chat({
    adapter: getModel("fast", { temperature: 0.2 }),
    messages: [{ role: "user", content: "Write a subject" }],
    stream: false,
  })
  expect(result).toBe("Updated knowledge")
  if (provider === "bedrock")
    expect(body).toMatchObject({
      inferenceConfig: { temperature: 0.2, maxTokens: 100, topP: 0.8 },
      additionalModelRequestFields: { reasoning_effort: "low" },
      messages: [{ role: "user", content: [{ text: "Write a subject" }] }],
    })
  else {
    expect(body).toMatchObject({
      model: "fast",
      stream: false,
      temperature: 0.2,
      max_tokens: 100,
      top_p: 0.8,
      messages: [{ role: "user", content: "Write a subject" }],
    })
    if (provider === "openrouter")
      expect(body).toMatchObject({
        models: ["medium", "high"],
        reasoning: { effort: "low" },
        plugins: [{ id: "context-compression" }],
        cache_control: { type: "ephemeral" },
      })
    else {
      expect(body).toMatchObject({ reasoning_effort: "low" })
      expect(body).not.toHaveProperty("models")
      expect(body).not.toHaveProperty("plugins")
    }
  }
})

it.each([
  "openrouter",
  "azure",
  "bedrock",
] as const)("parses and validates structured host output on %s", async (provider) => {
  const { z } = await import("zod")
  vi.stubEnv("MODEL_PROVIDER", provider)
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-key")
  vi.stubEnv("MODEL_PROVIDER_URL", "https://models.test/v1")
  vi.stubEnv("MODEL_FAST_NAME", "fast")
  vi.stubEnv("MODEL_BEDROCK_AWS_REGION", "us-east-1")
  vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-access")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-secret")
  const replies = [{ decision: "merge" }, { decision: "unsafe" }]
  server.use(
    http.post(
      provider === "bedrock"
        ? "https://bedrock-runtime.us-east-1.amazonaws.com/model/fast/converse"
        : "https://models.test/v1/chat/completions",
      async ({ request }) => {
        const body = await request.json()
        const name = "structured_output"
        const schema = {
          properties: { decision: { enum: ["merge", "new_name"] } },
        }
        expect(body).toMatchObject(
          provider === "bedrock"
            ? {
                toolConfig: {
                  tools: [
                    { toolSpec: { name, inputSchema: { json: schema } } },
                  ],
                  toolChoice: { tool: { name } },
                },
              }
            : {
                tools: [
                  { type: "function", function: { name, parameters: schema } },
                ],
                tool_choice: { type: "function", function: { name } },
              },
        )
        const data = replies.shift()
        return HttpResponse.json(
          provider === "bedrock"
            ? {
                output: {
                  message: {
                    role: "assistant",
                    content: [
                      { toolUse: { toolUseId: "call", name, input: data } },
                    ],
                  },
                },
                stopReason: "tool_use",
                usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
                metrics: { latencyMs: 1 },
              }
            : {
                id: "reply",
                model: "fast",
                choices: [
                  {
                    message: {
                      role: "assistant",
                      tool_calls: [
                        {
                          id: "call",
                          type: "function",
                          function: { name, arguments: JSON.stringify(data) },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: {
                  prompt_tokens: 4,
                  completion_tokens: 2,
                  total_tokens: 6,
                },
              },
        )
      },
    ),
  )
  const call = () =>
    chat({
      adapter: getModel("fast"),
      messages: [{ role: "user", content: "Classify the collision" }],
      outputSchema: z.object({ decision: z.enum(["merge", "new_name"]) }),
      stream: false,
    })
  await expect(call()).resolves.toEqual({ decision: "merge" })
  await expect(call()).rejects.toThrow()
})

const exporter = new InMemorySpanExporter()
const tracerProvider = new NodeTracerProvider({
  resource: resourceFromAttributes({}),
  spanProcessors: [
    new LangfuseContextSpanProcessor(),
    new SimpleSpanProcessor(exporter),
  ],
})
beforeAll(() => tracerProvider.register())
afterAll(() => tracerProvider.shutdown())

function stubOpenAiLike() {
  vi.stubEnv("MODEL_PROVIDER", "openai-like")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-key")
  vi.stubEnv("MODEL_PROVIDER_URL", "https://models.test/v1")
  vi.stubEnv("MODEL_FAST_NAME", "fast")
}

it("records each host call as one named Langfuse generation with usage", async () => {
  exporter.reset()
  stubOpenAiLike()
  server.use(
    http.post("https://models.test/v1/chat/completions", () =>
      HttpResponse.json({
        id: "reply",
        model: "fast",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "A subject" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }),
    ),
  )
  await chat({
    adapter: getModel("fast", { name: "workspace.commit-subject" }),
    messages: [{ role: "user", content: "Write a subject" }],
    stream: false,
  })
  const generations = exporter
    .getFinishedSpans()
    .filter(
      (span) => span.attributes["langfuse.observation.type"] === "generation",
    )
  expect(generations).toHaveLength(1)
  expect(generations[0]?.name).toBe("workspace.commit-subject")
  expect(generations[0]?.attributes["langfuse.observation.model.name"]).toBe(
    "fast",
  )
  expect(generations[0]?.attributes["langfuse.observation.input"]).toContain(
    "Write a subject",
  )
  expect(generations[0]?.attributes["langfuse.observation.output"]).toContain(
    "A subject",
  )
  expect(
    generations[0]?.attributes["langfuse.observation.usage_details"],
  ).toContain("10")
})

it("marks the generation as an error when the provider rejects the request", async () => {
  exporter.reset()
  stubOpenAiLike()
  server.use(
    http.post("https://models.test/v1/chat/completions", () =>
      HttpResponse.json({ error: "bad request" }, { status: 400 }),
    ),
  )
  await expect(
    chat({
      adapter: getModel("fast"),
      messages: [{ role: "user", content: "Write a subject" }],
      stream: false,
    }),
  ).rejects.toThrow(/400/)
  const failed = exporter
    .getFinishedSpans()
    .filter((span) => span.attributes["langfuse.observation.level"] === "ERROR")
  expect(failed).toHaveLength(1)
})

it.each([
  "openai-like",
  "bedrock",
] as const)("rejects a structured reply that has no tool call on %s", async (provider) => {
  const { z } = await import("zod")
  stubOpenAiLike()
  vi.stubEnv("MODEL_PROVIDER", provider)
  vi.stubEnv("MODEL_BEDROCK_AWS_REGION", "us-east-1")
  vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-access")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-secret")
  server.use(
    http.post(
      provider === "bedrock"
        ? "https://bedrock-runtime.us-east-1.amazonaws.com/model/fast/converse"
        : "https://models.test/v1/chat/completions",
      () =>
        HttpResponse.json(
          provider === "bedrock"
            ? {
                output: {
                  message: { role: "assistant", content: [{ text: "Sure" }] },
                },
                stopReason: "end_turn",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                metrics: { latencyMs: 1 },
              }
            : {
                id: "reply",
                model: "fast",
                choices: [
                  {
                    message: { role: "assistant", content: "Sure" },
                    finish_reason: "stop",
                  },
                ],
              },
        ),
    ),
  )
  await expect(
    chat({
      adapter: getModel("fast"),
      messages: [{ role: "user", content: "Classify" }],
      outputSchema: z.object({ decision: z.string() }),
      stream: false,
    }),
  ).rejects.toThrow(/structured output tool/)
})

it.each([
  "openai-like",
  "bedrock",
] as const)("aborts the provider request on %s when the caller cancels", async (provider) => {
  stubOpenAiLike()
  vi.stubEnv("MODEL_PROVIDER", provider)
  vi.stubEnv("MODEL_BEDROCK_AWS_REGION", "us-east-1")
  vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-access")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-secret")
  let sawRequest: () => void = () => {}
  const requested = new Promise<void>((resolve) => {
    sawRequest = resolve
  })
  server.use(
    http.post(
      provider === "bedrock"
        ? "https://bedrock-runtime.us-east-1.amazonaws.com/model/fast/converse"
        : "https://models.test/v1/chat/completions",
      async () => {
        sawRequest()
        await delay(1_500)
        return HttpResponse.json({})
      },
    ),
  )
  const cancellation = abortAfter(10_000)
  const call = chat({
    adapter: getModel("fast"),
    messages: [{ role: "user", content: "Write a subject" }],
    abortController: cancellation,
    stream: false,
  }).catch(() => "cancelled")
  await requested
  const cancelledAt = Date.now()
  cancellation.abort()
  // The provider replies after 1.5 s, so an earlier end means the request stopped.
  await expect(call).resolves.toBe("cancelled")
  expect(Date.now() - cancelledAt).toBeLessThan(1_000)
})

it.each([429, 503])("retries a transient HTTP %s response", async (status) => {
  stubOpenAiLike()
  let attempts = 0
  server.use(
    http.post("https://models.test/v1/chat/completions", () => {
      attempts += 1
      return attempts === 1
        ? HttpResponse.json({ error: "try again" }, { status })
        : HttpResponse.json({
            choices: [{ message: { role: "assistant", content: "Recovered" } }],
          })
    }),
  )
  await expect(
    chat({
      adapter: getModel("fast"),
      messages: [{ role: "user", content: "Write a subject" }],
      stream: false,
    }),
  ).resolves.toBe("Recovered")
  expect(attempts).toBe(2)
})

it.each([
  "openai-like",
  "bedrock",
] as const)("rejects a reply from an unrelated tool on %s", async (provider) => {
  const { z } = await import("zod")
  stubOpenAiLike()
  vi.stubEnv("MODEL_PROVIDER", provider)
  vi.stubEnv("MODEL_BEDROCK_AWS_REGION", "us-east-1")
  vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-access")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-secret")
  server.use(
    http.post(
      provider === "bedrock"
        ? "https://bedrock-runtime.us-east-1.amazonaws.com/model/fast/converse"
        : "https://models.test/v1/chat/completions",
      () =>
        HttpResponse.json(
          provider === "bedrock"
            ? {
                output: {
                  message: {
                    role: "assistant",
                    content: [
                      {
                        toolUse: {
                          toolUseId: "call",
                          name: "unrelated",
                          input: { decision: "merge" },
                        },
                      },
                    ],
                  },
                },
                stopReason: "tool_use",
                usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
                metrics: { latencyMs: 1 },
              }
            : {
                choices: [
                  {
                    message: {
                      role: "assistant",
                      tool_calls: [
                        {
                          id: "call",
                          type: "function",
                          function: {
                            name: "unrelated",
                            arguments: '{"decision":"merge"}',
                          },
                        },
                      ],
                    },
                  },
                ],
              },
        ),
    ),
  )
  await expect(
    chat({
      adapter: getModel("fast"),
      messages: [{ role: "user", content: "Classify" }],
      outputSchema: z.object({ decision: z.enum(["merge", "new_name"]) }),
      stream: false,
    }),
  ).rejects.toThrow(/structured output tool/)
})

it("cancels during retry backoff without another model request", async () => {
  stubOpenAiLike()
  const cancellation = new AbortController()
  let requests = 0
  let reachedBackoff!: () => void
  const backoff = new Promise<void>((resolve) => {
    reachedBackoff = resolve
  })
  server.use(
    http.post("https://models.test/v1/chat/completions", () => {
      requests += 1
      if (requests === 4) reachedBackoff()
      return HttpResponse.json({ error: "try again" }, { status: 429 })
    }),
  )
  const call = chat({
    adapter: getModel("fast"),
    messages: [{ role: "user", content: "Write a subject" }],
    abortController: cancellation,
    stream: false,
  }).catch(() => "cancelled")
  await backoff
  await delay(20)
  const start = Date.now()
  cancellation.abort()
  await expect(call).resolves.toBe("cancelled")
  expect(Date.now() - start).toBeLessThan(1_000)
  expect(requests).toBe(4)
})
