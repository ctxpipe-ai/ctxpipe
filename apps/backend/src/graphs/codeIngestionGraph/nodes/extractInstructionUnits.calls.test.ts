import { delay, HttpResponse, http } from "msw"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useMswServer } from "../../../../test/msw.js"
import { withOrgIdContext } from "../../../auth/withAuth.js"
import { withTestLogger } from "../../../test/with-test-logger.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"
import {
  deriveSharedRepoRootSkills,
  extractInstructionUnits,
  repoRootInstructionOwner,
} from "./extractInstructionUnits.js"

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

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
useMswServer(
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
  ownsRepoRootInstructions?: boolean,
): CodeIngestionState {
  return {
    repositoryId: "repo_calls",
    orgId: "org_calls",
    targetHash: "abc123",
    roots: [root],
    ...(ownsRepoRootInstructions === undefined
      ? {}
      : { ownsRepoRootInstructions }),
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
      const owner = repoRootInstructionOwner(roots)
      const outputs = []
      for (const root of roots)
        outputs.push(await run(rootState(root, root === owner)))

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
    "keeps repo-root files in a single-root run that has no owner flag",
    { timeout: 30_000 },
    async () => {
      stubEnv()
      await run(rootState("packages/alpha"))
      expect(requestedPaths).toContain("AGENTS.md")
    },
  )

  it(
    "extracts files of one root in parallel and keeps the output in file order",
    { timeout: 30_000 },
    async () => {
      stubEnv()
      const output = await run(rootState("./", true))
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

  it(
    "keeps the Skills of each package root with the repo-root units",
    { timeout: 30_000 },
    async () => {
      stubEnv()
      const roots = ["packages/beta", "packages/alpha"]
      const skillsOf = (
        objects: ExtractedObject[],
        claims: ExtractedClaim[],
      ) => ({
        skills: objects
          .filter((object) => object.kind === "Skill")
          .map((object) => object.deduplicationKey)
          .sort(),
        members: claims
          .filter((claim) => claim.predicate === "MEMBER_OF_PRIMARY")
          .map((claim) => claim.sourceId)
          .sort(),
      })
      const unique = <T>(items: T[]) => [...new Set(items)]

      // Before: each package root read the repo-root files itself.
      const before = {
        objects: [] as ExtractedObject[],
        claims: [] as ExtractedClaim[],
      }
      for (const root of roots) {
        const output = await run(rootState(root, true))
        before.objects.push(...(output.extractedObjects ?? []))
        before.claims.push(...(output.extractedClaims ?? []))
      }

      const owner = repoRootInstructionOwner(roots)
      const after = {
        objects: [] as ExtractedObject[],
        claims: [] as ExtractedClaim[],
      }
      for (const root of roots) {
        const output = await run(rootState(root, root === owner))
        after.objects.push(...(output.extractedObjects ?? []))
        after.claims.push(...(output.extractedClaims ?? []))
      }
      const shared = deriveSharedRepoRootSkills({
        repositoryId: "repo_calls",
        targetHash: "abc123",
        roots,
        capture: {
          extractedObjects: after.objects,
          extractedClaims: after.claims,
        },
      })
      after.objects.push(...shared.objects)
      after.claims.push(...shared.claims)

      const expected = skillsOf(before.objects, before.claims)
      const actual = skillsOf(after.objects, after.claims)
      expect(expected.skills.length).toBeGreaterThanOrEqual(2)
      expect(unique(actual.skills)).toEqual(unique(expected.skills))
      expect(unique(actual.members)).toEqual(unique(expected.members))
      // The Skill of packages/beta has the repo-root units and the beta unit.
      const bSkill = after.claims.filter(
        (claim) =>
          claim.predicate === "MEMBER_OF_PRIMARY" &&
          after.claims.some(
            (other) =>
              other.objectRef === claim.objectRef &&
              other.subjectRef.includes(":packages/beta:"),
          ),
      )
      expect(bSkill.some((claim) => claim.subjectRef.includes(":./:"))).toBe(
        true,
      )
    },
  )
})
