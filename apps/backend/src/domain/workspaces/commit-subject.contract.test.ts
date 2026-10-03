import { delay, HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { expect, it } from "vitest"
import { generateCommitSubject } from "./commit-subject.js"

it(
  "uses the fixed small model with a non-streaming filename-only request",
  { timeout: 30_000 },
  async () => {
    const keys = [
      "MODEL_PROVIDER",
      "MODEL_PROVIDER_API_KEY",
      "MODEL_PROVIDER_URL",
      "MODEL_FAST_NAME",
    ] as const
    const prior = new Map(keys.map((key) => [key, process.env[key]]))
    Object.assign(process.env, {
      MODEL_PROVIDER: "openai-like",
      MODEL_PROVIDER_API_KEY: "fixture-only",
      MODEL_PROVIDER_URL: "https://commit-subject.test/v1",
      MODEL_FAST_NAME: "arbitrary-large-tier-model",
    })
    const requests: Record<string, unknown>[] = []
    const signals: AbortSignal[] = []
    const server = setupServer(
      http.post(
        "https://commit-subject.test/v1/chat/completions",
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>
          requests.push(body)
          signals.push(request.signal)
          if (body.stream) {
            const chunks = [
              {
                id: "subject",
                object: "chat.completion.chunk",
                created: 1,
                model: "fixture",
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      content: "ctxpipe - Update reviewed knowledge",
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                id: "subject",
                object: "chat.completion.chunk",
                created: 1,
                model: "fixture",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              },
            ]
            return new HttpResponse(
              `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
              { headers: { "Content-Type": "text/event-stream" } },
            )
          }
          return HttpResponse.json({
            id: "subject",
            object: "chat.completion",
            created: 1,
            model: "fixture",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "ctxpipe - Update reviewed knowledge",
                },
                finish_reason: "stop",
              },
            ],
          })
        },
      ),
    )
    server.listen({ onUnhandledRequest: "error" })
    try {
      const subject = await generateCommitSubject({
        repoName: "knowledge",
        trigger: "ui_file_edit",
        fileNames: ["knowledge/reviewed.md"],
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        model: "anthropic/claude-haiku-4-5",
        stream: false,
      })
      expect(JSON.stringify(requests[0]?.messages)).toContain(
        "Changed files (names only): knowledge/reviewed.md",
      )
      expect(subject).toBe("ctxpipe - Update reviewed knowledge")
      // A completed request must not receive a later cancellation from a leftover deadline.
      await delay(5_200)
      expect(signals[0]?.aborted).toBe(false)
    } finally {
      server.close()
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  },
)

it(
  "aborts a slow subject request and uses the deterministic fallback",
  { timeout: 20_000 },
  async () => {
    const keys = [
      "MODEL_PROVIDER",
      "MODEL_PROVIDER_API_KEY",
      "MODEL_PROVIDER_URL",
    ] as const
    const prior = new Map(keys.map((key) => [key, process.env[key]]))
    Object.assign(process.env, {
      MODEL_PROVIDER: "openai-like",
      MODEL_PROVIDER_API_KEY: "fixture-only",
      MODEL_PROVIDER_URL: "https://commit-subject.test/v1",
    })
    let aborted = false
    const server = setupServer(
      http.post(
        "https://commit-subject.test/v1/chat/completions",
        async ({ request }) => {
          request.signal.addEventListener(
            "abort",
            () => {
              aborted = true
            },
            { once: true },
          )
          await delay(8_000)
          return HttpResponse.json({
            id: "slow",
            object: "chat.completion",
            created: 1,
            model: "fixture",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "ctxpipe - Late model subject",
                },
                finish_reason: "stop",
              },
            ],
          })
        },
      ),
    )
    server.listen({ onUnhandledRequest: "error" })
    try {
      const subject = await generateCommitSubject({
        repoName: "knowledge",
        trigger: "ui_file_edit",
        fileNames: ["knowledge/reviewed.md"],
      })
      expect(subject).toBe(
        "ctxpipe - Knowledge update of knowledge from ui_file_edit",
      )
      expect(aborted).toBe(true)
    } finally {
      server.close()
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  },
)
