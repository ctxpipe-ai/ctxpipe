import { HttpResponse, http } from "msw"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useMswServer } from "../../../test/msw.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { SlackApiError } from "./client.js"
import {
  formatSlackMentionStatusText,
  isSlackModelConfigured,
  selectSlackMentionIntent,
  stripSlackMentionText,
} from "./mention-agent.js"
import { classifySlackCaptureError } from "./sync.js"

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest owns this MSW lifecycle.
const server = useMswServer()
afterEach(() => vi.unstubAllEnvs())

describe("stripSlackMentionText", () => {
  it("treats a bare mention as empty remainder", () => {
    expect(stripSlackMentionText("<@U_BOT>")).toBe("")
    expect(stripSlackMentionText("<@U_BOT>   ")).toBe("")
  })

  it("keeps intent text after the mention", () => {
    expect(stripSlackMentionText("<@U_BOT> capture this")).toBe("capture this")
  })
})

describe("formatSlackMentionStatusText", () => {
  it("tells why nothing was captured when no Workspace has the channel", () => {
    expect(
      formatSlackMentionStatusText({ kind: "failed", errorCode: "no_source" }),
    ).toBe(
      "Nothing captured: no Workspace has this channel. Add the channel to a Slack source in the Workspace settings. If that opens a pull request, merge it. Then mention me again.",
    )
  })

  it("names the real cause of a Slack channel error", () => {
    const reply = (slackError: string) =>
      formatSlackMentionStatusText({
        kind: "failed",
        ...classifySlackCaptureError(
          new SlackApiError({ slackError, status: 200 }),
        ),
      })
    expect(reply("missing_scope")).toBe(
      "Capture failed: the ctx| Slack app needs more permissions to read this channel. Reinstall Slack.",
    )
    expect(reply("is_archived")).toBe(
      "Capture failed: this channel is archived.",
    )
    expect(reply("not_in_channel")).toBe(
      "Capture failed: invite the bot to this channel, then mention it again.",
    )
  })

  it("links each Workspace that got the thread", () => {
    expect(
      formatSlackMentionStatusText({
        kind: "captured",
        capture: { status: "completed", messageCount: 2 },
        workspaces: [
          { name: "context", url: "https://app.example/acme/ws/context" },
          { name: "R&D <ops>", url: "https://app.example/acme/ws/rd" },
        ],
      }),
    ).toBe(
      "Engineering context captured into <https://app.example/acme/ws/context|context>, <https://app.example/acme/ws/rd|R&amp;D &lt;ops&gt;>.",
    )
  })
})

describe("isSlackModelConfigured", () => {
  it("accepts an API key or Bedrock", () => {
    expect(
      isSlackModelConfigured({ MODEL_PROVIDER_API_KEY: "sk" } as never),
    ).toBe(true)
    expect(isSlackModelConfigured({ MODEL_PROVIDER: "bedrock" } as never)).toBe(
      true,
    )
    expect(isSlackModelConfigured({} as never)).toBe(false)
  })
})

describe("selectSlackMentionIntent", () => {
  const env = { MODEL_PROVIDER_API_KEY: "sk" } as never
  const select = (input: Parameters<typeof selectSlackMentionIntent>[0]) =>
    withLogger(createLogger({ test: "slack-mention" }), () =>
      selectSlackMentionIntent(input),
    )

  /** One model reply that carries the forced structured output tool call. */
  function answerWith(
    reply: unknown,
    seen: { body?: Record<string, unknown> } = {},
  ) {
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "sk")
    vi.stubEnv("MODEL_PROVIDER_URL", "https://models.test/v1")
    vi.stubEnv("MODEL_FAST_NAME", "fast")
    server.use(
      http.post(
        "https://models.test/v1/chat/completions",
        async ({ request }) => {
          seen.body = (await request.json()) as Record<string, unknown>
          return HttpResponse.json({
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
                      function: {
                        name: "mention_intent",
                        arguments: JSON.stringify(reply),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          })
        },
      ),
    )
    return seen
  }

  it("captures a bare mention without calling the model", async () => {
    // No msw handler: a model request would fail the test.
    await expect(
      select({
        env: {} as never,
        connectionId: "con_1",
        mentionText: "<@U_BOT>",
      }),
    ).resolves.toEqual({ kind: "capture" })
  })

  it("captures when the model confirms, with one structured call", async () => {
    const seen = answerWith({ capture: true })
    await expect(
      select({
        env,
        connectionId: "con_1",
        mentionText: "<@U_BOT> yes",
      }),
    ).resolves.toEqual({ kind: "capture" })
    expect(seen.body).toMatchObject({
      temperature: 0,
      tool_choice: { type: "function", function: { name: "mention_intent" } },
      messages: [
        { role: "system" },
        { role: "user", content: expect.stringContaining("yes") },
      ],
    })
    expect(JSON.stringify(seen.body)).not.toContain("U_BOT")
  })

  it("returns capability when the model says noise", async () => {
    answerWith({ capture: false })
    const result = await select({
      env,
      connectionId: "con_1",
      mentionText: "<@U_BOT> what is ctxpipe?",
    })
    expect(result).toEqual({ kind: "capability" })
    if (result.kind !== "capability") throw new Error("expected capability")
    expect(formatSlackMentionStatusText(result)).toMatch(/Ask me to capture/)
  })

  it("fails, and does not capture, when the model reply breaks the schema", async () => {
    answerWith({ capture: "maybe" })
    await expect(
      select({
        env,
        connectionId: "con_1",
        mentionText: "<@U_BOT> do it",
      }),
    ).resolves.toMatchObject({ kind: "failed", errorCode: "capture_failed" })
  })

  it("fails when the provider rejects the request", async () => {
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "sk")
    vi.stubEnv("MODEL_PROVIDER_URL", "https://models.test/v1")
    vi.stubEnv("MODEL_FAST_NAME", "fast")
    server.use(
      http.post("https://models.test/v1/chat/completions", () => {
        return HttpResponse.json({ error: "boom" }, { status: 400 })
      }),
    )
    await expect(
      select({
        env,
        connectionId: "con_1",
        mentionText: "<@U_BOT> please",
      }),
    ).resolves.toMatchObject({ kind: "failed", errorCode: "capture_failed" })
  })

  it("fails when remainder needs a model that is not configured", async () => {
    await expect(
      select({
        env: {} as never,
        connectionId: "con_1",
        mentionText: "<@U_BOT> capture this",
      }),
    ).resolves.toMatchObject({
      kind: "failed",
      errorCode: "model_not_configured",
    })
  })
})
