import { matchesGlob } from "node:path"
import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useMswServer } from "../../../../test/msw.js"
import { isConventionalEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import type { CodeIngestionState, ExtractedObject } from "../schemas.js"
import { extractGithubWorkflows } from "./extractGithubWorkflows.js"

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()

const files = new Map<string, string>([
  [
    ".github/workflows/ci.yml",
    `name: CI
on:
  push:
    branches: [main]
    paths:
      - "apps/backend/**"
      - "!apps/ui/docs/**"
      - ".github/workflows/ci.yml"
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test
        working-directory: apps/ui
  lint:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: apps/backend
    steps:
      - run: pnpm lint
`,
  ],
  [
    ".github/workflows/release.yaml",
    `on: workflow_dispatch
defaults:
  run:
    working-directory: packages/shared/src
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm publish
        working-directory: \${{ github.workspace }}
`,
  ],
  [
    ".github/workflows/nightly.yml",
    "on: [schedule, workflow_dispatch]\njobs:\n  audit: {}\n",
  ],
  [".github/workflows/broken.yml", "jobs: [unclosed"],
  [".github/workflows/no-jobs.yml", "name: Not a workflow\non: push\n"],
])

const packages: ExtractedObject[] = [
  { kind: "Service", deduplicationKey: "svc:repo_api:./", name: "./" },
  {
    kind: "Service",
    deduplicationKey: "svc:repo_api:apps/backend",
    name: "apps/backend",
  },
  { kind: "App", deduplicationKey: "app:repo_api:apps/ui", name: "apps/ui" },
  {
    kind: "Library",
    deduplicationKey: "lib:repo_api:packages/shared",
    name: "packages/shared",
  },
]

/** Production runs every extractor once per root, with that root's package only. */
function rootState(
  pkg: ExtractedObject,
  overrides: Partial<CodeIngestionState> = {},
): CodeIngestionState {
  return {
    repositoryId: "repo_api",
    orgId: "org_1",
    targetHash: "abc",
    roots: [pkg.deduplicationKey.split(":")[2] ?? "./"],
    extractedObjects: [pkg],
    extractedClaims: [],
    objectIds: [],
    touchedObjectIds: [],
    claimsForProjection: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-with-at-least-32-characters")
  vi.stubEnv("CODESEARCH_URL", "http://codesearch.test")
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://ctxpipe:ctxpipe@127.0.0.1:5433/ctxpipe",
  )
  server.use(
    http.post("http://codesearch.test/repo_api/glob", async ({ request }) => {
      const { pattern } = (await request.json()) as { pattern: string }
      const entries = [...files.keys()]
        .filter((path) => matchesGlob(path, pattern))
        .map((path) => ({ name: path.split("/").pop(), path, type: "file" }))
      return HttpResponse.json({
        entries,
        truncated: false,
        matched: entries.length,
      })
    }),
    http.post(
      "http://codesearch.test/repo_api/files-query",
      async ({ request }) => {
        const { paths } = (await request.json()) as { paths: string[] }
        return HttpResponse.json(
          Object.fromEntries(
            paths.map((path) => [
              path,
              Buffer.from(files.get(path) ?? "").toString("base64"),
            ]),
          ),
        )
      },
    ),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("extractGithubWorkflows", () => {
  it("emits Workflow nodes and MENTIONS for the packages they name, across per-root runs", async () => {
    const parts = await Promise.all(
      packages.map((pkg) => extractGithubWorkflows(rootState(pkg))),
    )

    for (const part of parts) {
      expect(part.extractedObjects).toEqual([
        {
          kind: "Workflow",
          deduplicationKey: "wfl:repo_api:.github/workflows/ci.yml",
          name: "CI",
          summary:
            "GitHub Actions workflow on push, pull_request; jobs: test, lint",
          payload: { path: ".github/workflows/ci.yml" },
        },
        {
          kind: "Workflow",
          deduplicationKey: "wfl:repo_api:.github/workflows/nightly.yml",
          name: "nightly.yml",
          summary:
            "GitHub Actions workflow on schedule, workflow_dispatch; jobs: audit",
          payload: { path: ".github/workflows/nightly.yml" },
        },
        {
          kind: "Workflow",
          deduplicationKey: "wfl:repo_api:.github/workflows/release.yaml",
          name: "release.yaml",
          summary:
            "GitHub Actions workflow on workflow_dispatch; jobs: publish",
          payload: { path: ".github/workflows/release.yaml" },
        },
      ])
    }
    const claims = parts.flatMap((part) => part.extractedClaims ?? [])
    expect(
      claims.map((c) => [c.subjectRef, c.objectRef, c.objectKind]),
    ).toEqual([
      [
        "wfl:repo_api:.github/workflows/ci.yml",
        "svc:repo_api:apps/backend",
        "Service",
      ],
      ["wfl:repo_api:.github/workflows/ci.yml", "app:repo_api:apps/ui", "App"],
      [
        "wfl:repo_api:.github/workflows/release.yaml",
        "lib:repo_api:packages/shared",
        "Library",
      ],
    ])
    for (const claim of claims) {
      expect(claim.predicate).toBe("MENTIONS")
      expect(
        isConventionalEvidenceSourceId(claim.sourceId, "repo_api", "abc"),
      ).toBe(true)
    }
  })

  it("skips connector-only diffs", async () => {
    expect(
      await extractGithubWorkflows(
        rootState(packages[1] as ExtractedObject, {
          ingestMode: "partial",
          changedPaths: ["github/pulls/acme/api/1.md"],
        }),
      ),
    ).toEqual({})
  })
})
