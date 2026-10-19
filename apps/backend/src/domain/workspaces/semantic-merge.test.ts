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
import {
  assertWriteOriginAllowed,
  resolveIngestConflicts,
  resolveSemanticConflicts,
  SemanticResolveError,
  writeOriginSchema,
} from "./semantic-merge.js"

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
    resolveSemanticConflicts(
      [
        {
          path: ".ctxpipe/sources.yaml",
          base: "sources: []\n",
          current: "sources:\n  - a\n",
          incoming: "sources:\n  - b\n",
        },
      ],
      { origin: "agent" },
    ),
  ).rejects.toThrow(/host-only/)
  expect(calls).toBe(0)
})

it("refuses a resolution that adds ownership fields that no side has", async () => {
  answer = [{ path: "knowledge/services/checkout.md", content: GENERATED }]
  await expect(
    resolveSemanticConflicts(
      [
        {
          path: "knowledge/services/checkout.md",
          base: HUMAN,
          current: `${HUMAN}\nCurrent.\n`,
          incoming: `${HUMAN}\nIncoming.\n`,
        },
      ],
      { origin: "agent" },
    ),
  ).rejects.toThrow(/ownership/)
  expect(calls).toBe(1)
})

it("accepts a resolution that keeps the ownership fields of one side", async () => {
  answer = [{ path: "knowledge/services/checkout.md", content: GENERATED }]
  await expect(
    resolveSemanticConflicts(
      [
        {
          path: "knowledge/services/checkout.md",
          base: null,
          current: GENERATED,
          incoming: HUMAN,
        },
      ],
      { origin: "agent" },
    ),
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
  await expect(
    resolveSemanticConflicts([conflict], { origin: "agent" }),
  ).rejects.toThrow(/ownership/)
  await expect(
    resolveSemanticConflicts([conflict], { origin: "extraction" }),
  ).rejects.toThrow(/ownership/)
})

it("refuses ownership fields that only the incoming side has when it is not a host write", async () => {
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
      { origin: "agent" },
    ),
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
      { origin: "extraction" },
    ),
  ).resolves.toEqual(answer)
})

it("refuses an agent write to a host-only path that does not conflict", () => {
  expect(() =>
    assertWriteOriginAllowed({
      origin: "agent",
      files: [{ path: ".ctxpipe/sources.yaml", content: "a: 1\n" }],
      deletePaths: [],
      current: new Map(),
    }),
  ).toThrow(/host-only/)
  expect(() =>
    assertWriteOriginAllowed({
      origin: "agent",
      files: [],
      deletePaths: [".CTXPIPE/sources.yaml"],
      current: new Map(),
    }),
  ).toThrow(/host-only/)
})

it("refuses an agent write that adds ownership fields without a conflict", () => {
  expect(() =>
    assertWriteOriginAllowed({
      origin: "agent",
      files: [{ path: "knowledge/services/checkout.md", content: GENERATED }],
      deletePaths: [],
      current: new Map([["knowledge/services/checkout.md", HUMAN]]),
    }),
  ).toThrow(/ownership/)
})

it("allows an agent write that keeps the ownership fields of the default branch", () => {
  expect(() =>
    assertWriteOriginAllowed({
      origin: "agent",
      files: [
        {
          path: "knowledge/services/checkout.md",
          content: `${GENERATED}\nMore.\n`,
        },
      ],
      deletePaths: [],
      current: new Map([["knowledge/services/checkout.md", GENERATED]]),
    }),
  ).not.toThrow()
})

it("lets extraction output add host-stamped ownership fields but not touch a host-only path", () => {
  expect(() =>
    assertWriteOriginAllowed({
      origin: "extraction",
      files: [{ path: "knowledge/services/checkout.md", content: GENERATED }],
      deletePaths: [],
      current: new Map(),
    }),
  ).not.toThrow()
  expect(() =>
    assertWriteOriginAllowed({
      origin: "extraction",
      files: [{ path: ".ctxpipe/sources.yaml", content: "a: 1\n" }],
      deletePaths: [],
      current: new Map(),
    }),
  ).toThrow(/host-only/)
})

it("treats a missing or unknown origin as an agent write", () => {
  for (const origin of [undefined, "person"])
    expect(writeOriginSchema.parse(origin)).toBe("agent")
})

const ingestConflicts = [
  {
    path: "knowledge/services/checkout.md",
    base: HUMAN,
    current: `${HUMAN}\nCurrent.\n`,
    incoming: `${HUMAN}\nIncoming.\n`,
  },
]

it("lets an invalid provider setting of an ingest merge propagate as itself", async () => {
  vi.stubEnv("MODEL_PROVIDER", "not-a-provider")
  const error = await resolveIngestConflicts(ingestConflicts).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(SemanticResolveError)
})

it("wraps a failed model call of an ingest merge in a SemanticResolveError", async () => {
  server.use(
    http.post("https://semantic-merge.test/v1/chat/completions", () =>
      HttpResponse.json({ error: { message: "unavailable" } }, { status: 400 }),
    ),
  )
  await expect(resolveIngestConflicts(ingestConflicts)).rejects.toBeInstanceOf(
    SemanticResolveError,
  )
}, 60_000)

// CTX-899: a model that skips the forced output tool once must not fail the
// whole re-ingestion.
const slipThen = (slips: number) =>
  http.post("https://semantic-merge.test/v1/chat/completions", () => {
    if (calls >= slips) return undefined
    calls += 1
    return HttpResponse.json({
      id: "merge",
      object: "chat.completion",
      created: 1,
      model: "fixture",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Here is the merge." },
          finish_reason: "stop",
        },
      ],
    })
  })

it("asks the merge model again when it does not call the output tool", async () => {
  answer = [{ path: ingestConflicts[0].path, content: `${HUMAN}\nBoth.\n` }]
  server.use(slipThen(2))
  await expect(resolveIngestConflicts(ingestConflicts)).resolves.toEqual(answer)
  expect(calls).toBe(3)
})

it("fails the merge with the cause after a bounded count of slips", async () => {
  server.use(slipThen(Number.POSITIVE_INFINITY))
  await expect(resolveIngestConflicts(ingestConflicts)).rejects.toThrow(
    "The semantic merge failed: The model did not call the structured output tool (3 attempts)",
  )
  expect(calls).toBe(3)
})

// CTX-721: each file under sources/ is one source. Only the host writes it
// without a pull request.
it("lets a host write change sources/ and refuses an agent or extraction write", () => {
  const write = {
    files: [{ path: "sources/github/example-org/web.md", content: "a\n" }],
    deletePaths: ["sources/linear/eng.md"],
    current: new Map<string, string>(),
  }
  expect(() =>
    assertWriteOriginAllowed({ origin: "host", ...write }),
  ).not.toThrow()
  for (const origin of ["agent", "extraction"] as const)
    expect(() => assertWriteOriginAllowed({ origin, ...write })).toThrow(
      /host-only/,
    )
})
