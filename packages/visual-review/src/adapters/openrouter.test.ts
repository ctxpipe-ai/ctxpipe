import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@blazediff/codec-png-native"
import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest"

import { screenshot } from "../compare/fixtures.ts"
import {
  buildPrompt,
  judgementJsonSchema,
  judgeWithOpenRouter,
  openRouterModelId,
  openRouterPrices,
  usageCost,
  type StoryInput,
} from "../index.ts"

const directory = mkdtempSync(join(tmpdir(), "visual-review-"))
const regionsBytes = Buffer.from("regions-image")
const locatorBytes = Buffer.from("locator-image")
writeFileSync(join(directory, "regions.png"), regionsBytes)
writeFileSync(join(directory, "locator.png"), locatorBytes)

const story: StoryInput = {
  storyId: "connectors-catalog--default",
  scope: "component",
  viewport: { width: 1440, height: 900 },
  regions: [
    {
      box: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
      changeType: "content-change",
      position: "top-left",
      confidence: 0.9,
    },
  ],
  images: [
    { role: "regions", path: join(directory, "regions.png") },
    { role: "locator", path: join(directory, "locator.png") },
  ],
  brief: "Rename the button to Add connection.",
  sourceDiff: "-  <Button>Connect</Button>\n+  <Button>Add connection</Button>",
}

const judgement = {
  observations: [
    {
      region: 1,
      before: "A white button with the word Connect.",
      after: "A white button with the words Add connection.",
    },
  ],
  verdict: "intended",
  severity: "none",
  confidence: 0.8,
  summary: "The button label changed as the brief asks.",
  qualities: [{ name: "clarity", delta: "better", confidence: 0.7 }],
  findings: [],
}

const env = {
  MODEL_PROVIDER_API_KEY: "test-key",
  MODEL_PROVIDER_URL: "https://gateway.test/api/v1",
}

type Seen = { headers: Headers; body: Record<string, unknown> }
let seen: Seen | undefined
const reply = (
  content: string,
  usage: Record<string, unknown> | null = { cost: 0.0123 },
) =>
  http.post(
    "https://gateway.test/api/v1/chat/completions",
    async ({ request }) => {
      seen = {
        headers: request.headers,
        body: (await request.json()) as Record<string, unknown>,
      }
      return HttpResponse.json({
        choices: [{ message: { role: "assistant", content } }],
        ...(usage ? { usage } : {}),
      })
    },
  )

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => {
  server.resetHandlers()
  seen = undefined
})
afterAll(() => server.close())

describe("judgeWithOpenRouter", () => {
  test("sends the cached prefix, the story text, then the images as data URLs", async () => {
    server.use(reply(JSON.stringify(judgement)))

    await judgeWithOpenRouter(story, "anthropic/claude-sonnet-5.5", env)

    const prompt = buildPrompt(story)
    expect(seen?.headers.get("authorization")).toBe("Bearer test-key")
    expect(seen?.body.model).toBe("anthropic/claude-sonnet-5.5")
    expect(seen?.body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt.prefix,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: prompt.story },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${regionsBytes.toString("base64")}`,
            },
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${locatorBytes.toString("base64")}`,
            },
          },
        ],
      },
    ])
  })

  test("a PNG with a side over 1568 px or under 280 px is scaled or padded before it is sent", async () => {
    server.use(reply(JSON.stringify(judgement)))
    writeFileSync(join(directory, "wide.png"), screenshot(3000, 600, []))
    writeFileSync(join(directory, "small.png"), screenshot(100, 100, []))

    await judgeWithOpenRouter(
      {
        ...story,
        images: [
          { role: "regions", path: join(directory, "wide.png") },
          { role: "locator", path: join(directory, "small.png") },
        ],
      },
      "anthropic/claude-sonnet-5.5",
      env,
    )

    const messages = seen?.body.messages as
      | { content: { type: string; image_url?: { url: string } }[] }[]
      | undefined
    const content = messages?.[0]?.content
    const sizes = (content ?? []).flatMap((part) => {
      if (!part.image_url) return []
      const { width, height } = decode(
        Buffer.from(part.image_url.url.split(",")[1] ?? "", "base64"),
      )
      return [{ width, height }]
    })
    expect(sizes).toEqual([
      { width: 1568, height: 314 },
      { width: 280, height: 280 },
    ])
  })

  test("asks for the strict critic JSON Schema and denies data collection", async () => {
    server.use(reply(JSON.stringify(judgement)))

    await judgeWithOpenRouter(story, "google/gemini-4-argon", env)

    expect(seen?.body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "visual_verdict",
        strict: true,
        schema: judgementJsonSchema,
      },
    })
    expect(seen?.body.provider).toEqual({ data_collection: "deny" })
  })

  test("maps a native Claude id to the OpenRouter id", async () => {
    server.use(reply(JSON.stringify(judgement)))

    const verdict = await judgeWithOpenRouter(
      story,
      "anthropic/claude-sonnet-4-5-20250929",
      env,
    )

    expect(seen?.body.model).toBe("anthropic/claude-sonnet-4.5")
    expect(verdict.model).toBe("anthropic/claude-sonnet-4-5-20250929")
  })

  test("parses the answer into the critic verdict with the cost from usage.cost", async () => {
    server.use(
      reply(JSON.stringify(judgement), { cost: 0.0123, total_tokens: 5 }),
    )

    const verdict = await judgeWithOpenRouter(story, "openai/gpt-6.1-sol", env)

    expect(verdict).toMatchObject({
      storyId: "connectors-catalog--default",
      ...judgement,
      model: "openai/gpt-6.1-sol",
      costUsd: 0.0123,
    })
    expect(verdict.error).toBeUndefined()
  })

  test("the cost is null when the response has no usage.cost", async () => {
    server.use(reply(JSON.stringify(judgement), null))

    const verdict = await judgeWithOpenRouter(story, "openai/gpt-6.1-sol", env)

    expect(verdict.costUsd).toBeNull()
  })

  test("measures the latency of the call", async () => {
    vi.useFakeTimers({ toFake: ["performance"] })
    try {
      server.use(
        http.post("https://gateway.test/api/v1/chat/completions", () => {
          // The provider takes 60 ms to answer.
          vi.advanceTimersByTime(60)
          return HttpResponse.json({
            choices: [{ message: { content: JSON.stringify(judgement) } }],
            usage: { cost: 0.001 },
          })
        }),
      )

      const verdict = await judgeWithOpenRouter(
        story,
        "openai/gpt-6.1-sol",
        env,
      )

      expect(verdict.latencyMs).toBe(60)
    } finally {
      vi.useRealTimers()
    }
  })

  test("a reply that is not usable gives unsure with the cause", async () => {
    server.use(reply("I think the change is fine."))

    const verdict = await judgeWithOpenRouter(story, "openai/gpt-6.1-sol", env)

    expect(verdict.verdict).toBe("unsure")
    expect(verdict.error).toMatch(/JSON/)
    expect(verdict.costUsd).toBe(0.0123)
  })

  test("a provider error fails with the status and the message", async () => {
    server.use(
      http.post("https://gateway.test/api/v1/chat/completions", () =>
        HttpResponse.json(
          { error: { code: 402, message: "Insufficient credits" } },
          { status: 402 },
        ),
      ),
    )

    await expect(
      judgeWithOpenRouter(story, "openai/gpt-6.1-sol", env),
    ).rejects.toThrow(/402.*Insufficient credits/)
  })

  test("a response without a message fails", async () => {
    server.use(
      http.post("https://gateway.test/api/v1/chat/completions", () =>
        HttpResponse.json({ choices: [] }),
      ),
    )

    await expect(
      judgeWithOpenRouter(story, "openai/gpt-6.1-sol", env),
    ).rejects.toThrow(/no message/i)
  })

  test("a 200 response with an error and no message fails with the provider message", async () => {
    server.use(
      http.post("https://gateway.test/api/v1/chat/completions", () =>
        HttpResponse.json({ error: { message: "Upstream provider failed" } }),
      ),
    )

    await expect(
      judgeWithOpenRouter(story, "openai/gpt-6.1-sol", env),
    ).rejects.toThrow(/no message.*Upstream provider failed/)
  })

  test("uses the OpenRouter URL when MODEL_PROVIDER_URL is not set", async () => {
    server.use(
      http.post("https://openrouter.ai/api/v1/chat/completions", () =>
        HttpResponse.json({
          choices: [{ message: { content: JSON.stringify(judgement) } }],
          usage: { cost: 0.002 },
        }),
      ),
    )

    const verdict = await judgeWithOpenRouter(story, "openai/gpt-6.1-sol", {
      MODEL_PROVIDER_API_KEY: "test-key",
    })

    expect(verdict.costUsd).toBe(0.002)
  })

  test("fails clearly without a key", async () => {
    await expect(
      judgeWithOpenRouter(story, "openai/gpt-6.1-sol", {}),
    ).rejects.toThrow(/MODEL_PROVIDER_API_KEY/)
  })

  test("rejects an image type that a vision model does not take", async () => {
    writeFileSync(join(directory, "diff.bmp"), "x")
    server.use(reply(JSON.stringify(judgement)))

    await expect(
      judgeWithOpenRouter(
        {
          ...story,
          images: [{ role: "diff", path: join(directory, "diff.bmp") }],
        },
        "openai/gpt-6.1-sol",
        env,
      ),
    ).rejects.toThrow(/bmp/)
  })
})

describe("openRouterModelId", () => {
  test("maps native Claude ids to OpenRouter ids", () => {
    expect(openRouterModelId("anthropic/claude-sonnet-4-5-20250929")).toBe(
      "anthropic/claude-sonnet-4.5",
    )
    expect(openRouterModelId("anthropic/claude-opus-4-1")).toBe(
      "anthropic/claude-opus-4.1",
    )
    expect(openRouterModelId("anthropic/claude-sonnet-4.5")).toBe(
      "anthropic/claude-sonnet-4.5",
    )
  })

  test("keeps OpenAI and other ids, and drops an openrouter prefix", () => {
    expect(openRouterModelId("openai/gpt-5")).toBe("openai/gpt-5")
    expect(openRouterModelId("openrouter/openai/gpt-5")).toBe("openai/gpt-5")
  })

  test("rejects an id without a provider", () => {
    expect(() => openRouterModelId("gpt-5")).toThrow(/provider\/model/)
  })
})

describe("openRouterPrices and usageCost", () => {
  test("prices the models from the OpenRouter list, and leaves an unlisted model unknown", async () => {
    server.use(
      http.get("https://prices.test/v1/models", () =>
        HttpResponse.json({
          data: [
            {
              id: "anthropic/claude-sonnet-4.5",
              pricing: { prompt: "0.000003", completion: "0.000015" },
            },
            { id: "openai/unpriced", pricing: {} },
            {
              id: "other/model",
              pricing: { prompt: "0.000001", completion: "0.000002" },
            },
          ],
        }),
      ),
    )

    const prices = await openRouterPrices("https://prices.test/v1/", [
      "anthropic/claude-sonnet-4.5",
      "openai/unpriced",
    ])

    expect([...prices.keys()]).toEqual(["anthropic/claude-sonnet-4.5"])
    expect(
      usageCost(
        { inputTokens: 1_000, outputTokens: 100 },
        prices.get("anthropic/claude-sonnet-4.5"),
      ),
    ).toBeCloseTo(0.0045)
    expect(
      usageCost(
        { inputTokens: 1_000, outputTokens: 100 },
        prices.get("openai/unpriced"),
      ),
    ).toBeUndefined()
  })

  test("gives no prices when the list does not load", async () => {
    server.use(
      http.get("https://down.test/v1/models", () =>
        HttpResponse.json({}, { status: 503 }),
      ),
    )

    const prices = await openRouterPrices("https://down.test/v1", [
      "anthropic/claude-sonnet-4.5",
    ])

    expect(prices.size).toBe(0)
  })
})
