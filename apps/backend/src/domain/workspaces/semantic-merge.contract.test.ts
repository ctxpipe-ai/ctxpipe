import { HttpResponse, http } from "msw"
import { afterEach, expect, it, vi } from "vitest"
import { useMswServer } from "../../../test/msw.js"
import { classifyUnkeyedKnowledgeCollision } from "./dest-workspace-first.js"
import { resolveSemanticConflicts } from "./semantic-merge.js"

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest owns this MSW lifecycle.
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

/** Reply with a forced tool call, and keep the request body. */
function replyWithToolCall(
  reply: unknown,
  requests: Record<string, unknown>[],
) {
  server.use(
    http.post("https://merge.test/v1/chat/completions", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      requests.push(body)
      const tools = body.tools as Array<{ function: { name: string } }>
      return HttpResponse.json({
        id: "merge",
        model: "fixture",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: tools[0]?.function.name,
                    arguments: JSON.stringify(reply),
                  },
                },
              ],
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

it("resolves conflicts with one forced structured call on the high tier", async () => {
  configureModel()
  const requests: Record<string, unknown>[] = []
  replyWithToolCall(
    {
      files: [
        { path: "a.md", content: "merged" },
        { path: "b.md", content: null },
      ],
    },
    requests,
  )
  await expect(resolveSemanticConflicts(conflicts)).resolves.toEqual([
    { path: "a.md", content: "merged" },
    { path: "b.md", content: null },
  ])
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    model: "high-model",
    stream: false,
    tool_choice: { type: "function" },
  })
  expect(JSON.stringify(requests[0]?.messages)).toContain("a.md")
})

it("rejects a resolution that misses a conflicting path", async () => {
  configureModel()
  replyWithToolCall({ files: [{ path: "a.md", content: "merged" }] }, [])
  await expect(resolveSemanticConflicts(conflicts)).rejects.toThrow(
    "did not resolve exactly",
  )
})

it("rejects a resolution that adds a path outside the conflicts", async () => {
  configureModel()
  replyWithToolCall(
    {
      files: [
        { path: "a.md", content: "merged" },
        { path: "c.md", content: "extra" },
      ],
    },
    [],
  )
  await expect(resolveSemanticConflicts(conflicts)).rejects.toThrow(
    "did not resolve exactly",
  )
})

it.each([
  ["merge", "merge"],
  ["new_name", "new_name"],
] as const)("classifies a collision as %s through the fast tier", async (decision, expected) => {
  configureModel()
  const requests: Record<string, unknown>[] = []
  replyWithToolCall({ decision }, requests)
  await expect(
    classifyUnkeyedKnowledgeCollision({
      existingPath: "knowledge/a.md",
      incomingPath: "knowledge/a.md",
      existingExcerpt: "one",
      incomingExcerpt: "two",
    }),
  ).resolves.toBe(expected)
  expect(requests[0]).toMatchObject({ model: "fast-model", stream: false })
})

it("falls back to a new name when the model returns a value outside the enum", async () => {
  configureModel()
  replyWithToolCall({ decision: "unsure" }, [])
  await expect(
    classifyUnkeyedKnowledgeCollision({
      existingPath: "knowledge/a.md",
      incomingPath: "knowledge/a.md",
      existingExcerpt: "one",
      incomingExcerpt: "two",
    }),
  ).resolves.toBe("new_name")
})
