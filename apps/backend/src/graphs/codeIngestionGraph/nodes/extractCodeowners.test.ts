import { beforeEach, describe, expect, it, vi } from "vitest"
import { isConventionalEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import type { CodeIngestionState, ExtractedObject } from "../schemas.js"

const mocks = vi.hoisted(() => ({ globFiles: vi.fn(), fetchFiles: vi.fn() }))

vi.mock("../../../domain/codeIngestion/codesearchClient.js", () => ({
  globFiles: mocks.globFiles,
  fetchFiles: mocks.fetchFiles,
}))

import {
  codeownersPatternCoversRoot,
  extractCodeowners,
  owningRuleForRoot,
  parseCodeowners,
} from "./extractCodeowners.js"

const CODEOWNERS = `# Default owners
*                     @acme/platform alice@example.com
/apps/backend/        @acme/backend @alice
apps/ui/**            @acme/frontend
packages/shared       @acme/platform   # trailing comment
*.md                  @acme/docs
docs/*.md             @acme/docs
`

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

beforeEach(() => {
  vi.clearAllMocks()
  mocks.globFiles.mockImplementation(
    async (_repo: string, _org: string, opts: { pattern: string }) => ({
      entries:
        opts.pattern === ".github/CODEOWNERS"
          ? [{ type: "file", path: ".github/CODEOWNERS" }]
          : [],
    }),
  )
  mocks.fetchFiles.mockResolvedValue({ ".github/CODEOWNERS": CODEOWNERS })
})

describe("parseCodeowners / coverage", () => {
  it("parses rules, strips comments, and applies directory coverage with last-match-wins", () => {
    const rules = parseCodeowners(CODEOWNERS)
    expect(rules).toHaveLength(6)
    expect(rules[3]).toEqual({
      pattern: "packages/shared",
      owners: ["@acme/platform"],
    })

    expect(codeownersPatternCoversRoot("*", "./")).toBe(true)
    expect(codeownersPatternCoversRoot("/apps/backend/", "apps/backend")).toBe(
      true,
    )
    expect(
      codeownersPatternCoversRoot("/apps/backend/", "apps/backend/src"),
    ).toBe(true)
    expect(codeownersPatternCoversRoot("apps/ui/**", "apps/ui")).toBe(true)
    expect(codeownersPatternCoversRoot("apps/**", "apps/ui")).toBe(true)
    expect(codeownersPatternCoversRoot("ui", "apps/ui")).toBe(true)
    expect(codeownersPatternCoversRoot("/ui", "apps/ui")).toBe(false)
    expect(codeownersPatternCoversRoot("*.md", "apps/ui")).toBe(false)
    expect(codeownersPatternCoversRoot("docs/*.md", "docs")).toBe(false)
    expect(codeownersPatternCoversRoot("/apps/backend/", "./")).toBe(false)

    expect(owningRuleForRoot(rules, "apps/backend")?.owners).toEqual([
      "@acme/backend",
      "@alice",
    ])
    expect(owningRuleForRoot(rules, "./")?.owners).toEqual([
      "@acme/platform",
      "alice@example.com",
    ])
    expect(owningRuleForRoot(rules, "apps/ui")?.owners).toEqual([
      "@acme/frontend",
    ])
  })
})

describe("extractCodeowners", () => {
  it("emits Team OWNS package claims for team owners only", async () => {
    const { extractedObjects = [], extractedClaims = [] } =
      await extractCodeowners(state())

    expect(extractedObjects.map((o) => o.deduplicationKey).sort()).toEqual([
      "team:github:acme/backend",
      "team:github:acme/frontend",
      "team:github:acme/platform",
    ])
    expect(
      extractedObjects.find(
        (o) => o.deduplicationKey === "team:github:acme/backend",
      ),
    ).toMatchObject({
      kind: "Team",
      name: "acme/backend",
      payload: { key: "backend", org: "acme", source: "github" },
    })

    expect(
      extractedClaims
        .map((c) => [c.subjectRef, c.objectRef, c.objectKind])
        .sort(),
    ).toEqual([
      ["team:github:acme/backend", "svc:repo_api:apps/backend", "Service"],
      ["team:github:acme/frontend", "app:repo_api:apps/ui", "App"],
      ["team:github:acme/platform", "lib:repo_api:packages/shared", "Library"],
      ["team:github:acme/platform", "svc:repo_api:./", "Service"],
    ])
    for (const claim of extractedClaims) {
      expect(claim.predicate).toBe("OWNS")
      expect(
        isConventionalEvidenceSourceId(claim.sourceId, "repo_api", "abc"),
      ).toBe(true)
    }
  })

  it("returns nothing without packages, without a CODEOWNERS file, or on connector-only diffs", async () => {
    expect(await extractCodeowners(state({ extractedObjects: [] }))).toEqual({})
    mocks.globFiles.mockResolvedValue({ entries: [] })
    expect(await extractCodeowners(state())).toEqual({})
    expect(
      await extractCodeowners(
        state({
          ingestMode: "partial",
          changedPaths: ["github/pulls/a/b/1--1.md"],
        }),
      ),
    ).toEqual({})
  })
})
