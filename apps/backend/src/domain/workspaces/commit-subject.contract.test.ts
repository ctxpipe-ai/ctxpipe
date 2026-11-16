import { delay, HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

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
    const server = setupServer(
      http.post(
        "https://commit-subject.test/v1/chat/completions",
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>
          requests.push(body)
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
    } finally {
      server.close()
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  },
)

function subjectResponse(content: string) {
  return HttpResponse.json({
    id: "subject",
    object: "chat.completion",
    created: 1,
    model: "fixture",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  })
}

describe("subject deadline", () => {
  const keys = [
    "MODEL_PROVIDER",
    "MODEL_PROVIDER_API_KEY",
    "MODEL_PROVIDER_URL",
  ] as const
  const prior = new Map(keys.map((key) => [key, process.env[key]]))
  const server = setupServer()

  beforeAll(() => {
    Object.assign(process.env, {
      MODEL_PROVIDER: "openai-like",
      MODEL_PROVIDER_API_KEY: "fixture-only",
      MODEL_PROVIDER_URL: "https://commit-subject.test/v1",
    })
    server.listen({ onUnhandledRequest: "error" })
  })
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  })
  afterEach(() => {
    vi.useRealTimers()
    server.resetHandlers()
  })
  afterAll(() => {
    server.close()
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const input = {
    repoName: "knowledge",
    trigger: "ui_file_edit",
    fileNames: ["knowledge/reviewed.md"],
  }

  // Production answers took up to 4.6 s; a 5 s deadline aborted 5 of 759.
  it("keeps a model subject that arrives after 7 s", async () => {
    const signals: AbortSignal[] = []
    server.use(
      http.post(
        "https://commit-subject.test/v1/chat/completions",
        async ({ request }) => {
          signals.push(request.signal)
          await delay(7_000)
          return subjectResponse("ctxpipe - Slow but valid subject")
        },
      ),
    )
    const subject = generateCommitSubject(input)
    await vi.advanceTimersByTimeAsync(7_000)
    await expect(subject).resolves.toBe("ctxpipe - Slow but valid subject")
    // A completed request must not receive a later cancellation from a leftover deadline.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(signals[0]?.aborted).toBe(false)
  })

  it("aborts a hung subject request and uses the deterministic fallback", async () => {
    let aborted = false
    server.use(
      http.post(
        "https://commit-subject.test/v1/chat/completions",
        ({ request }) =>
          new Promise<Response>((_, reject) => {
            request.signal.addEventListener(
              "abort",
              () => {
                aborted = true
                reject(request.signal.reason)
              },
              { once: true },
            )
          }),
      ),
    )
    const subject = generateCommitSubject(input)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(subject).resolves.toBe(
      "ctxpipe - Knowledge update of knowledge from ui_file_edit",
    )
    expect(aborted).toBe(true)
  })
})
