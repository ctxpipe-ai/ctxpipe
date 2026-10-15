import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest"
import { resolveSemanticConflicts } from "./semantic-merge.js"

const HUMAN = "---\nkind: Service\nname: Checkout\n---\n\n# Checkout\n"
const GENERATED =
  "---\nkind: Service\nname: Checkout\ngenerated_by: ctxpipe-extract\nsources:\n  - https://github.com/fixture/checkout\n---\n\n# Checkout\n"

let answer: Array<{ path: string; content: string | null }> = []
let calls = 0
const server = setupServer(
  http.post("https://semantic-merge.test/v1/chat/completions", () => {
    calls += 1
    return HttpResponse.json({
      id: "merge",
      object: "chat.completion",
      created: 1,
      model: "fixture",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "workspace_semantic_merge",
                  arguments: JSON.stringify({ files: answer }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterAll(() => server.close())
beforeEach(() => {
  calls = 0
  vi.stubEnv("MODEL_PROVIDER", "openai-like")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
  vi.stubEnv("MODEL_PROVIDER_URL", "https://semantic-merge.test/v1")
  for (const tier of ["FAST", "MEDIUM", "HIGH"])
    vi.stubEnv(`MODEL_${tier}_NAME`, "fixture-model")
})
afterEach(() => {
  vi.unstubAllEnvs()
  server.resetHandlers()
})

it("refuses a conflict on a host-only path and does not send it to the model", async () => {
  await expect(
    resolveSemanticConflicts([
      {
        path: ".ctxpipe/sources.yaml",
        base: "sources: []\n",
        current: "sources:\n  - a\n",
        incoming: "sources:\n  - b\n",
      },
    ]),
  ).rejects.toThrow(/host-only/)
  expect(calls).toBe(0)
})

it("refuses a resolution that adds ownership fields that no side has", async () => {
  answer = [{ path: "knowledge/services/checkout.md", content: GENERATED }]
  await expect(
    resolveSemanticConflicts([
      {
        path: "knowledge/services/checkout.md",
        base: HUMAN,
        current: `${HUMAN}\nCurrent.\n`,
        incoming: `${HUMAN}\nIncoming.\n`,
      },
    ]),
  ).rejects.toThrow(/ownership/)
  expect(calls).toBe(1)
})

it("accepts a resolution that keeps the ownership fields of one side", async () => {
  answer = [{ path: "knowledge/services/checkout.md", content: GENERATED }]
  await expect(
    resolveSemanticConflicts([
      {
        path: "knowledge/services/checkout.md",
        base: null,
        current: GENERATED,
        incoming: HUMAN,
      },
    ]),
  ).resolves.toEqual(answer)
})

it("refuses to give a file back to ingestion after a person took it over", async () => {
  // A pull request removed the ownership fields (current); a host write that
  // still has them (incoming) conflicts with it, and the model keeps the base.
  answer = [{ path: "knowledge/services/checkout.md", content: GENERATED }]
  const conflict = {
    path: "knowledge/services/checkout.md",
    base: GENERATED,
    current: `${HUMAN}\nPerson.\n`,
    incoming: `${GENERATED}\nHost.\n`,
  }
  await expect(resolveSemanticConflicts([conflict])).rejects.toThrow(
    /ownership/,
  )
  await expect(
    resolveSemanticConflicts([conflict], { incomingIsHostWrite: true }),
  ).rejects.toThrow(/ownership/)
})

it("refuses ownership fields that only the incoming side has when it is not a host write", async () => {
  answer = [{ path: "knowledge/services/checkout.md", content: GENERATED }]
  await expect(
    resolveSemanticConflicts([
      {
        path: "knowledge/services/checkout.md",
        base: HUMAN,
        current: `${HUMAN}\nCurrent.\n`,
        incoming: GENERATED,
      },
    ]),
  ).rejects.toThrow(/ownership/)
})

it("accepts ownership fields that a host write adds in a shard join", async () => {
  answer = [{ path: "knowledge/services/checkout.md", content: GENERATED }]
  await expect(
    resolveSemanticConflicts(
      [
        {
          path: "knowledge/services/checkout.md",
          base: HUMAN,
          current: `${HUMAN}\nCurrent.\n`,
          incoming: GENERATED,
        },
      ],
      { incomingIsHostWrite: true },
    ),
  ).resolves.toEqual(answer)
})
