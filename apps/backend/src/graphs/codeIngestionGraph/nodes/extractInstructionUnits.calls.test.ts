import { delay, HttpResponse, http } from "msw"
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
import { withOrgIdContext } from "../../../auth/withAuth.js"
import { withTestLogger } from "../../../test/with-test-logger.js"
import type { CodeIngestionState } from "../schemas.js"
import { extractInstructionUnits } from "./extractInstructionUnits.js"

const CODESEARCH = "https://codesearch.instruction-calls.test"
const MODEL = "https://model.instruction-calls.test/v1"

const files: Record<string, string> = {
  "AGENTS.md": "# Agents\n\nUse pnpm from the repository root.\n",
  ".agents/skills/release/SKILL.md": "# Release\n\nRun changesets first.\n",
  "CONTRIBUTING.md": "# Contributing\n\nSign every commit.\n",
  "packages/alpha/AGENTS.md": "# Alpha\n\nKeep alpha pure.\n",
  "packages/beta/AGENTS.md": "# Beta\n\nKeep beta small.\n",
}

const requestedPaths: string[] = []
const fetchedPaths: string[] = []
let inFlight = 0
let maxInFlight = 0

const server = setupServer(
  http.post(`${CODESEARCH}/:repositoryId/glob`, () =>
    HttpResponse.json({
      entries: Object.keys(files).map((path) => ({ path, type: "file" })),
      truncated: false,
      matched: Object.keys(files).length,
    }),
  ),
  http.post(`${CODESEARCH}/:repositoryId/files-query`, async ({ request }) => {
    const { paths } = (await request.json()) as { paths: string[] }
    fetchedPaths.push(...paths)
    return HttpResponse.json(
      Object.fromEntries(
        paths.map((path) => [
          path,
          Buffer.from(files[path] ?? "").toString("base64"),
        ]),
      ),
    )
  }),
  http.post(`${MODEL}/chat/completions`, async ({ request }) => {
    const body = (await request.json()) as {
      messages: Array<{ content: string }>
      tools?: Array<{ function: { name: string } }>
    }
    const human = body.messages.at(-1)?.content ?? ""
    const path = /File path: (.+)\n/.exec(human)?.[1] ?? "?"
    requestedPaths.push(path)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await delay(40)
    inFlight--
    const excerpt = files[path]?.split("\n")[2] ?? "Unknown."
    const units = {
      units: [
        {
          name: `Rule from ${path}`,
          summary: excerpt,
          source_excerpt: excerpt,
          modality: "required",
          intent: "Keep the repository consistent",
          applicability: { tags: [], scope: "repository", environment: null },
          durable: true,
        },
      ],
    }
    const tool = body.tools?.find(
      (t) => t.function.name === "instruction_units",
    )
    return HttpResponse.json({
      id: "instruction-calls",
      object: "chat.completion",
      created: 1,
      model: "fixture",
      choices: [
        {
          index: 0,
          message: tool
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "units",
                    type: "function",
                    function: {
                      name: "instruction_units",
                      arguments: JSON.stringify(units),
                    },
                  },
                ],
              }
            : { role: "assistant", content: JSON.stringify(units) },
          finish_reason: tool ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterAll(() => server.close())
afterEach(() => {
  requestedPaths.length = 0
  fetchedPaths.length = 0
  maxInFlight = 0
  vi.unstubAllEnvs()
})

function stubEnv() {
  vi.stubEnv("CODESEARCH_URL", CODESEARCH)
  // parseEnv needs a URL; the step tracker swallows its refused connection.
  vi.stubEnv("DATABASE_URL", "postgres://fixture:fixture@127.0.0.1:1/none")
  vi.stubEnv("AUTH_SECRET", "instruction-calls-secret-at-least-32-chars")
  vi.stubEnv("MODEL_PROVIDER", "openai-like")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
  vi.stubEnv("MODEL_PROVIDER_URL", MODEL)
  vi.stubEnv("MODEL_MEDIUM_NAME", "fixture-medium")
}

function rootState(
  root: string,
  extractionRoots: string[],
): CodeIngestionState {
  return {
    repositoryId: "repo_calls",
    orgId: "org_calls",
    targetHash: "abc123",
    roots: [root],
    extractionRoots,
    extractedObjects: [],
    extractedClaims: [],
  }
}

function run(state: CodeIngestionState) {
  return withTestLogger(() =>
    withOrgIdContext({ id: "org_calls", slug: "calls" }, () =>
      extractInstructionUnits(state),
    ),
  )
}

describe("extractInstructionUnits model calls", () => {
  it(
    "extracts each repo-root instruction file once in a run of package roots",
    { timeout: 30_000 },
    async () => {
      stubEnv()
      const roots = ["packages/beta", "packages/alpha"]
      const outputs = []
      for (const root of roots) outputs.push(await run(rootState(root, roots)))

      expect([...requestedPaths].sort()).toEqual([
        ".agents/skills/release/SKILL.md",
        "AGENTS.md",
        "CONTRIBUTING.md",
        "packages/alpha/AGENTS.md",
        "packages/beta/AGENTS.md",
      ])
      // A root reads only the files that it extracts.
      expect(fetchedPaths.filter((path) => path === "AGENTS.md")).toHaveLength(
        1,
      )
      // The first root in path order owns the repo-root files.
      const [beta, alpha] = outputs
      const repoRootUnits = (output: typeof alpha) =>
        (output?.extractedClaims ?? []).filter(
          (claim) => claim.subjectRef === "svc:repo_calls:./",
        )
      expect(repoRootUnits(alpha)).toHaveLength(3)
      expect(repoRootUnits(beta)).toHaveLength(0)
      expect(
        beta?.extractedObjects?.some(
          (object) => object.deduplicationKey === "svc:repo_calls:./",
        ),
      ).toBe(false)
    },
  )

  it(
    "keeps repo-root files in a single-root run without the run's root list",
    { timeout: 30_000 },
    async () => {
      stubEnv()
      const state = rootState("packages/alpha", [])
      delete state.extractionRoots
      await run(state)
      expect(requestedPaths).toContain("AGENTS.md")
    },
  )

  it(
    "extracts files of one root in parallel and keeps the output in file order",
    { timeout: 30_000 },
    async () => {
      stubEnv()
      const output = await run(rootState("./", ["./"]))
      expect(maxInFlight).toBeGreaterThan(1)
      expect(maxInFlight).toBeLessThanOrEqual(4)
      const order = (output.extractedObjects ?? [])
        .filter((object) => object.kind === "InstructionUnit")
        .map((object) => (object.payload as { path: string }).path)
      expect(order).toEqual([
        ".agents/skills/release/SKILL.md",
        "AGENTS.md",
        "packages/alpha/AGENTS.md",
        "packages/beta/AGENTS.md",
        "CONTRIBUTING.md",
      ])
    },
  )
})
