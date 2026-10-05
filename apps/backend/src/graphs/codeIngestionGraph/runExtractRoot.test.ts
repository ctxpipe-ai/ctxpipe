import { matchesGlob } from "node:path"
import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useMswServer } from "../../../test/msw.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { runIdentifyPhaseForRoot, stableRootStepId } from "./runExtractRoot.js"
import type { CodeIngestionState, ExtractedObject } from "./schemas.js"

const repository = new Map<string, string>([
  [
    ".ai/memory/decisions/ADR-010-graph-db.md",
    "# ADR-010: Graph DB\n\n**Status:** Accepted\n\nThe backend (`apps/backend/src/platform/graph/client.ts`) owns graph access.\n",
  ],
  [".github/CODEOWNERS", "/apps/ui/  @acme/web\n"],
  ["AGENTS.md", "# Agents\n\n- Always run `pnpm lint` before you commit.\n"],
])
const modelRequests: string[] = []

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
useMswServer(
  http.post(
    "http://codesearch.test/:repositoryId/glob",
    async ({ request }) => {
      const { pattern } = (await request.json()) as { pattern: string }
      const entries = [...repository.keys()]
        .filter((path) => matchesGlob(path, pattern))
        .map((path) => ({ name: path.split("/").pop(), path, type: "file" }))
      return HttpResponse.json({
        entries,
        truncated: false,
        matched: entries.length,
      })
    },
  ),
  http.post(
    "http://codesearch.test/:repositoryId/files-query",
    async ({ request }) => {
      const { paths } = (await request.json()) as { paths: string[] }
      return HttpResponse.json(
        Object.fromEntries(
          paths.map((path) => [
            path,
            Buffer.from(repository.get(path) ?? "").toString("base64"),
          ]),
        ),
      )
    },
  ),
  http.all("http://model.test/*", ({ request }) => {
    modelRequests.push(new URL(request.url).pathname)
    return HttpResponse.json({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "test",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: '{"units":[]}' },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  }),
)

beforeEach(() => {
  modelRequests.length = 0
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-with-at-least-32-characters")
  vi.stubEnv("CODESEARCH_URL", "http://codesearch.test")
  // Env parsing needs a value. The extractors do not connect to Postgres.
  vi.stubEnv("DATABASE_URL", "postgresql://unused:unused@127.0.0.1:1/unused")
  vi.stubEnv("MODEL_PROVIDER", "openai-like")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", "http://model.test/v1")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("stableRootStepId", () => {
  it("maps repo root aliases to repo-root", () => {
    expect(stableRootStepId("./")).toBe("repo-root")
    expect(stableRootStepId(".")).toBe("repo-root")
    expect(stableRootStepId("")).toBe("repo-root")
  })

  it("sanitizes nested paths for OW step names", () => {
    expect(stableRootStepId("apps/backend")).toBe("apps_backend")
    expect(stableRootStepId("./packages/foo-bar")).toBe("packages_foo-bar")
  })
})

describe("runIdentifyPhaseForRoot", () => {
  const service = (root: string): ExtractedObject => ({
    kind: "Service",
    deduplicationKey: `svc:repo_api:${root}`,
    name: root,
  })
  const state = {
    repositoryId: "repo_api",
    orgId: "org_1",
    targetHash: "abc",
    roots: ["apps/ui"],
    extractedObjects: [],
    extractedClaims: [],
    objectIds: [],
    touchedObjectIds: [],
    claimsForProjection: [],
  } satisfies CodeIngestionState
  const identifyUi = (options: { deterministicOnly?: boolean }) =>
    withLogger(createLogger({ test: "run-extract-root" }), () =>
      withOrgIdContext({ id: "org_1", slug: "acme" }, () =>
        runIdentifyPhaseForRoot(
          state,
          "apps/ui",
          { extractedObjects: [service("apps/ui")] },
          {
            ...options,
            packageObjects: [service("apps/backend"), service("apps/ui")],
          },
        ),
      ),
    )

  it("calls the model when the LLM extractors run", async () => {
    await identifyUi({})
    expect(modelRequests.length).toBeGreaterThan(0)
  })

  it("runs only the deterministic extractors on a deterministic-only run", async () => {
    const { extractedClaims } = await identifyUi({ deterministicOnly: true })

    expect(modelRequests).toEqual([])
    const triples = extractedClaims.map(
      (claim) =>
        `${claim.subjectRef} ${claim.predicate} ${claim.objectRef} ${claim.confidence}`,
    )
    // Decisions see the packages of every root, not only this root.
    expect(triples.filter((triple) => triple.includes(" INFLUENCES "))).toEqual(
      [
        "dec:repo_api:.ai/memory/decisions/ADR-010-graph-db.md INFLUENCES svc:repo_api:apps/backend 0.8",
      ],
    )
    expect(triples.some((triple) => triple.includes(" OWNS "))).toBe(true)
  })
})
