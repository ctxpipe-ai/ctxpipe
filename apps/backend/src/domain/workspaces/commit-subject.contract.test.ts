import { delay, HttpResponse, http } from "msw"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { useMswServer } from "../../../test/msw.js"
import { generateCommitSubject } from "./commit-subject.js"

const completions = "https://commit-subject.test/v1/chat/completions"
const server = useMswServer()

beforeEach(() => {
  vi.stubEnv("MODEL_PROVIDER", "openai-like")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
  vi.stubEnv("MODEL_PROVIDER_URL", "https://commit-subject.test/v1")
  vi.stubEnv("MODEL_FAST_NAME", "arbitrary-large-tier-model")
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

const input = {
  repoName: "knowledge",
  trigger: "ui_file_edit",
  fileNames: ["knowledge/reviewed.md"],
}

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

it("uses the fixed small model with a non-streaming filename-only request", async () => {
  const requests: Record<string, unknown>[] = []
  server.use(
    http.post(completions, async ({ request }) => {
      requests.push((await request.json()) as Record<string, unknown>)
      return subjectResponse("ctxpipe - Update reviewed knowledge")
    }),
  )
  const subject = await generateCommitSubject(input)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    model: "anthropic/claude-haiku-4-5",
    stream: false,
  })
  expect(JSON.stringify(requests[0]?.messages)).toContain(
    "Changed files (names only): knowledge/reviewed.md",
  )
  expect(subject).toBe("ctxpipe - Update reviewed knowledge")
})

// Production answers took up to 4.6 s; a 5 s deadline aborted 5 of 759.
it("keeps a model subject that arrives after 7 s", async () => {
  const signals: AbortSignal[] = []
  server.use(
    http.post(completions, async ({ request }) => {
      signals.push(request.signal)
      await delay(7_000)
      return subjectResponse("ctxpipe - Slow but valid subject")
    }),
  )
  const subject = generateCommitSubject(input)
  // The prompt goes through the secret scrubber (a process) first, so the
  // request arrives after real I/O, not in the same tick.
  await vi.waitFor(() => expect(signals).toHaveLength(1))
  await vi.advanceTimersByTimeAsync(7_000)
  await expect(subject).resolves.toBe("ctxpipe - Slow but valid subject")
  // A completed request must not receive a later cancellation from a leftover deadline.
  await vi.advanceTimersByTimeAsync(20_000)
  expect(signals[0]?.aborted).toBe(false)
})

it("aborts a hung subject request and uses the deterministic fallback", async () => {
  let aborted = false
  let received = false
  server.use(
    http.post(
      completions,
      ({ request }) =>
        new Promise<Response>((_, reject) => {
          received = true
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
  await vi.waitFor(() => expect(received).toBe(true))
  await vi.advanceTimersByTimeAsync(15_000)
  await expect(subject).resolves.toBe(
    "ctxpipe - Knowledge update of knowledge from ui_file_edit",
  )
  expect(aborted).toBe(true)
})
