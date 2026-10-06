import { matchesGlob } from "node:path"
import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useMswServer } from "../../../../test/msw.js"
import { isConventionalEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import type { CodeIngestionState, ExtractedObject } from "../schemas.js"
import {
  extractGithubWorkflows,
  parseGithubWorkflow,
  workflowLocationPrefix,
} from "./extractGithubWorkflows.js"

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()

const CI = `name: CI
on:
  push:
    branches: [main]
    paths:
      - "apps/backend/**"
      - "!apps/backend/docs/**"
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
`

const RELEASE = `on: workflow_dispatch
defaults:
  run:
    working-directory: packages/shared/src
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm publish
        working-directory: \${{ github.workspace }}
`

const files = new Map<string, string>([
  [".github/workflows/ci.yml", CI],
  [".github/workflows/release.yaml", RELEASE],
  [".github/workflows/broken.yml", "jobs: [unclosed"],
  ["apps/backend/package.json", "{}"],
])

function pkg(
  kind: "Service" | "App" | "Library",
  prefix: string,
  root: string,
): ExtractedObject {
  return { kind, deduplicationKey: `${prefix}:repo_api:${root}`, name: root }
}

function state(
  overrides: Partial<CodeIngestionState> = {},
): CodeIngestionState {
  return {
    repositoryId: "repo_api",
    orgId: "org_1",
    targetHash: "abc",
    roots: ["./"],
    extractedObjects: [
      pkg("Service", "svc", "./"),
      pkg("Service", "svc", "apps/backend"),
      pkg("App", "app", "apps/ui"),
      pkg("Library", "lib", "packages/shared"),
    ],
    extractedClaims: [],
    objectIds: [],
    touchedObjectIds: [],
    claimsForProjection: [],
    ...overrides,
  }
}

let fetchedPaths: string[][] = []

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-with-at-least-32-characters")
  vi.stubEnv("CODESEARCH_URL", "http://codesearch.test")
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://ctxpipe:ctxpipe@127.0.0.1:5433/ctxpipe",
  )
  fetchedPaths = []
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
        fetchedPaths.push(paths)
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

describe("parseGithubWorkflow", () => {
  it("reads the name, triggers, jobs, path filters and working directories", () => {
    expect(parseGithubWorkflow(CI, ".github/workflows/ci.yml")).toEqual({
      name: "CI",
      triggers: ["push", "pull_request"],
      jobs: ["test", "lint"],
      locations: [
        "apps/backend/**",
        "!apps/backend/docs/**",
        ".github/workflows/ci.yml",
        "apps/ui",
        "apps/backend",
      ],
    })
    expect(
      parseGithubWorkflow(RELEASE, ".github/workflows/release.yaml"),
    ).toMatchObject({
      name: "release.yaml",
      triggers: ["workflow_dispatch"],
      locations: ["packages/shared/src", `\${{ github.workspace }}`],
    })
    expect(
      parseGithubWorkflow("on: [push, pull_request]\njobs:\n  a: {}\n", "w.yml")
        ?.triggers,
    ).toEqual(["push", "pull_request"])
  })

  it("rejects invalid YAML and files without jobs", () => {
    expect(parseGithubWorkflow("jobs: [unclosed", "w.yml")).toBeNull()
    expect(parseGithubWorkflow("name: x\non: push\n", "w.yml")).toBeNull()
  })
})

describe("workflowLocationPrefix", () => {
  it("keeps the directory before the first glob segment", () => {
    expect(workflowLocationPrefix("apps/backend/**")).toBe("apps/backend")
    expect(workflowLocationPrefix("apps/*/src/**")).toBe("apps")
    expect(workflowLocationPrefix("./apps/ui")).toBe("apps/ui")
    expect(workflowLocationPrefix("!apps/backend/docs/**")).toBeNull()
    expect(workflowLocationPrefix(`\${{ github.workspace }}/x`)).toBeNull()
    expect(workflowLocationPrefix("**/*.ts")).toBeNull()
    expect(workflowLocationPrefix(".")).toBeNull()
  })
})

describe("extractGithubWorkflows", () => {
  it("emits Workflow nodes and MENTIONS for each package they name", async () => {
    const { extractedObjects = [], extractedClaims = [] } =
      await extractGithubWorkflows(state())

    expect(extractedObjects).toEqual([
      {
        kind: "Workflow",
        deduplicationKey: "wfl:repo_api:.github/workflows/ci.yml",
        name: "CI",
        summary:
          "GitHub Actions workflow on push, pull_request; jobs: test, lint",
        payload: {
          path: ".github/workflows/ci.yml",
          triggers: ["push", "pull_request"],
          jobs: ["test", "lint"],
        },
      },
      {
        kind: "Workflow",
        deduplicationKey: "wfl:repo_api:.github/workflows/release.yaml",
        name: "release.yaml",
        summary: "GitHub Actions workflow on workflow_dispatch; jobs: publish",
        payload: {
          path: ".github/workflows/release.yaml",
          triggers: ["workflow_dispatch"],
          jobs: ["publish"],
        },
      },
    ])
    expect(
      extractedClaims.map((c) => [c.subjectRef, c.objectRef, c.objectKind]),
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
    for (const claim of extractedClaims) {
      expect(claim.predicate).toBe("MENTIONS")
      expect(
        isConventionalEvidenceSourceId(claim.sourceId, "repo_api", "abc"),
      ).toBe(true)
    }
  })

  it("reads only changed workflows on a partial ingest and skips connector-only diffs", async () => {
    const partial = await extractGithubWorkflows(
      state({
        ingestMode: "partial",
        changedPaths: [".github/workflows/release.yaml"],
      }),
    )
    expect(partial.extractedObjects?.map((o) => o.name)).toEqual([
      "release.yaml",
    ])
    expect(fetchedPaths).toEqual([[".github/workflows/release.yaml"]])

    expect(
      await extractGithubWorkflows(
        state({
          ingestMode: "partial",
          changedPaths: ["apps/backend/src/server.ts"],
        }),
      ),
    ).toEqual({})
    expect(
      await extractGithubWorkflows(
        state({
          ingestMode: "partial",
          changedPaths: ["github/pulls/acme/api/1.md"],
        }),
      ),
    ).toEqual({})
    expect(fetchedPaths).toHaveLength(1)
  })
})
