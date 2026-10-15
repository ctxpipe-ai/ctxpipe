import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  resolveIngestConflicts,
  SemanticResolveError,
} from "./semantic-merge.js"

const MODEL_URL = "https://merge-model.test/v1"
const conflicts = [
  { path: "knowledge/a.md", base: "b", current: "c", incoming: "i" },
] as never

const server = setupServer(
  http.post(`${MODEL_URL}/chat/completions`, () =>
    HttpResponse.json({ error: { message: "unavailable" } }, { status: 400 }),
  ),
)

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

describe("resolveIngestConflicts", () => {
  it("lets an invalid provider setting propagate as itself", async () => {
    vi.stubEnv("MODEL_PROVIDER", "not-a-provider")
    const error = await resolveIngestConflicts(conflicts).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(SemanticResolveError)
  })

  it("wraps a failed model call in a SemanticResolveError", async () => {
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
    vi.stubEnv("MODEL_PROVIDER_URL", MODEL_URL)
    vi.stubEnv("MODEL_HIGH_NAME", "fixture-high")
    await expect(resolveIngestConflicts(conflicts)).rejects.toBeInstanceOf(
      SemanticResolveError,
    )
  }, 60_000)
})
