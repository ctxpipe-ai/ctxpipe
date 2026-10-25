import { HttpResponse, http } from "msw"
import { afterEach, expect, it, vi } from "vitest"

import { useMswServer } from "../../../test/msw.js"
import { classifyUnkeyedKnowledgeCollision } from "./dest-workspace-first.js"
import { resolveSemanticConflicts } from "./semantic-merge.js"

const server = useMswServer()
afterEach(() => vi.unstubAllEnvs())

function configureModel() {
  vi.stubEnv("MODEL_PROVIDER", "openai-like")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
  vi.stubEnv("MODEL_PROVIDER_URL", "https://merge.test/v1")
  vi.stubEnv("MODEL_FAST_NAME", "fast-model")
  vi.stubEnv("MODEL_MEDIUM_NAME", "medium-model")
  vi.stubEnv("MODEL_HIGH_NAME", "high-model")
}

/** Reply with JSON schema output, and keep the request body. */
function replyWithStructuredOutput(
  reply: unknown | ((body: Record<string, unknown>) => unknown),
  requests: Record<string, unknown>[],
) {
  server.use(
    http.post("https://merge.test/v1/chat/completions", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      requests.push(body)
      return HttpResponse.json({
        id: "merge",
        model: "fixture",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify(
                typeof reply === "function" ? reply(body) : reply,
              ),
            },
          },
        ],
      })
    }),
  )
}

const conflicts = [
  { path: "a.md", base: "one", current: "two", incoming: "three" },
  { path: "b.md", base: null, current: "x", incoming: "y" },
]

it("resolves each conflicting file with one structured call on the high tier", async () => {
  configureModel()
  const requests: Record<string, unknown>[] = []
  // One file per call, so a large merge does not reach the time limit (CTX-958).
  replyWithStructuredOutput(
    (body: Record<string, unknown>) =>
      JSON.stringify(body.messages).includes("a.md")
        ? { files: [{ path: "a.md", content: "merged" }] }
        : { files: [{ path: "b.md", content: null }] },
    requests,
  )
  await expect(
    resolveSemanticConflicts(conflicts, { origin: "agent" }),
  ).resolves.toEqual([
    { path: "a.md", content: "merged" },
    { path: "b.md", content: null },
  ])
  expect(requests).toHaveLength(2)
  for (const request of requests)
    expect(request).toMatchObject({
      model: "high-model",
      stream: false,
      response_format: { type: "json_schema" },
    })
})

it("rejects a resolution that misses a conflicting path", async () => {
  configureModel()
  replyWithStructuredOutput(
    { files: [{ path: "a.md", content: "merged" }] },
    [],
  )
  await expect(
    resolveSemanticConflicts(conflicts, { origin: "agent" }),
  ).rejects.toThrow("did not resolve exactly")
})

it("rejects a resolution that adds a path outside the conflicts", async () => {
  configureModel()
  replyWithStructuredOutput(
    {
      files: [
        { path: "a.md", content: "merged" },
        { path: "c.md", content: "extra" },
      ],
    },
    [],
  )
  await expect(
    resolveSemanticConflicts(conflicts, { origin: "agent" }),
  ).rejects.toThrow("did not resolve exactly")
})

it.each([
  ["merge", "merge"],
  ["new_name", "new_name"],
] as const)(
  "classifies a collision as %s through the fast tier",
  async (decision, expected) => {
    configureModel()
    const requests: Record<string, unknown>[] = []
    replyWithStructuredOutput({ decision }, requests)
    await expect(
      classifyUnkeyedKnowledgeCollision({
        existingPath: "knowledge/a.md",
        incomingPath: "knowledge/a.md",
        existingExcerpt: "one",
        incomingExcerpt: "two",
      }),
    ).resolves.toBe(expected)
    expect(requests[0]).toMatchObject({ model: "fast-model", stream: false })
  },
)

it("falls back to a new name when the model returns a value outside the enum", async () => {
  configureModel()
  replyWithStructuredOutput({ decision: "unsure" }, [])
  await expect(
    classifyUnkeyedKnowledgeCollision({
      existingPath: "knowledge/a.md",
      incomingPath: "knowledge/a.md",
      existingExcerpt: "one",
      incomingExcerpt: "two",
    }),
  ).resolves.toBe("new_name")
})
