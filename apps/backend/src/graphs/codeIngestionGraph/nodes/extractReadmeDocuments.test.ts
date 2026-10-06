import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { isConventionalEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import { createLogger, withLogger } from "../../../observability/logger.js"
import type { CodeIngestionState } from "../schemas.js"
import {
  extractReadmeDocuments,
  parseReadmeMarkdown,
} from "./extractReadmeDocuments.js"

const CODESEARCH = "http://codesearch.test"
const REPO = "repo_mono"

let files: Record<string, string> = {}
let fetchedPaths: string[] = []

const server = setupServer(
  http.post(`${CODESEARCH}/${REPO}/glob`, () =>
    HttpResponse.json({
      entries: Object.keys(files).map((path) => ({
        name: path.split("/").pop(),
        path,
        type: "file",
      })),
      truncated: false,
      matched: Object.keys(files).length,
    }),
  ),
  http.post(`${CODESEARCH}/${REPO}/files-query`, async ({ request }) => {
    const { paths } = (await request.json()) as { paths: string[] }
    fetchedPaths = paths
    return HttpResponse.json(
      Object.fromEntries(
        paths.map((path) => [
          path,
          Buffer.from(files[path] ?? "").toString("base64"),
        ]),
      ),
    )
  }),
)

function state(
  overrides: Partial<CodeIngestionState> = {},
): CodeIngestionState {
  return {
    repositoryId: REPO,
    orgId: "org_1",
    targetHash: "abc",
    roots: ["packages/payments"],
    extractedObjects: [
      {
        kind: "Service",
        deduplicationKey: `svc:${REPO}:packages/payments`,
        name: "payments",
      },
    ],
    extractedClaims: [],
    objectIds: [],
    touchedObjectIds: [],
    claimsForProjection: [],
    ...overrides,
  }
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterAll(() => server.close())
beforeEach(() => {
  vi.stubEnv("CODESEARCH_URL", CODESEARCH)
  vi.stubEnv("AUTH_SECRET", "x".repeat(32))
  vi.stubEnv("DATABASE_URL", "postgresql://unused@localhost/unused")
  fetchedPaths = []
  files = {
    "README.md": "# Monorepo\n\nEverything the company ships.\n",
    "packages/payments/README.md": "# Payments\n\nCharges cards.\n",
    "packages/payments/src/ledger/README.md":
      "# Ledger\n\nDouble-entry postings, reconciled nightly.\n\n## Gotchas\n\nNever edit a posted entry.\n",
    "infra/terraform/readme.md": "Terraform for the shared network.\n",
    "docs/empty/README.md": "  \n",
    "node_modules/left-pad/README.md": "# left-pad\n",
    "notion/engineering/README.md": "# Mirrored page\n",
  }
})
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})

describe("parseReadmeMarkdown", () => {
  it("takes the first H1 as title and the next prose paragraph as summary", () => {
    expect(
      parseReadmeMarkdown(
        "[![ci](https://ci.example/badge.svg)](https://ci.example)\n\n# Ledger\n\nDouble-entry postings.\n",
        "src/ledger/README.md",
      ),
    ).toMatchObject({
      title: "Ledger",
      excerpt: expect.stringContaining("Double-entry"),
    })
  })

  it("falls back to frontmatter title, then the directory", () => {
    expect(
      parseReadmeMarkdown("---\ntitle: Billing\n---\nBody.\n", "x/README.md"),
    ).toMatchObject({ title: "Billing", summary: "Body." })
    expect(
      parseReadmeMarkdown("Just prose.\n", "infra/terraform/README.md"),
    ).toMatchObject({ title: "infra/terraform", summary: "Just prose." })
  })

  it("returns null for an empty file", () => {
    expect(parseReadmeMarkdown(" \n", "README.md")).toBeNull()
  })
})

describe("extractReadmeDocuments", () => {
  it("makes every README a Document located in its package or the repository", async () => {
    const out = await extractReadmeDocuments(state())

    const documents = out.extractedObjects.filter((o) => o.kind === "Document")
    expect(documents.map((d) => d.payload?.path)).toEqual([
      "README.md",
      "infra/terraform/readme.md",
      "packages/payments/README.md",
      "packages/payments/src/ledger/README.md",
    ])
    expect(
      documents.find(
        (d) => d.payload?.path === "packages/payments/src/ledger/README.md",
      ),
    ).toMatchObject({
      deduplicationKey: `doc:${REPO}:packages/payments/src/ledger/README.md`,
      name: "Ledger",
      summary: "Double-entry postings, reconciled nightly.",
      payload: {
        excerpt: expect.stringContaining("Never edit a posted entry."),
      },
    })

    const edges = out.extractedClaims.map(
      (c) => `${c.subjectRef} ${c.predicate} ${c.objectRef}`,
    )
    expect(edges).toEqual(
      expect.arrayContaining([
        `doc:${REPO}:packages/payments/src/ledger/README.md DECLARED_IN fil:${REPO}:packages/payments/src/ledger/README.md`,
        `fil:${REPO}:packages/payments/src/ledger/README.md PART_OF svc:${REPO}:packages/payments`,
        `doc:${REPO}:infra/terraform/readme.md DECLARED_IN fil:${REPO}:infra/terraform/readme.md`,
        `fil:${REPO}:infra/terraform/readme.md PART_OF ${REPO}`,
      ]),
    )
    expect(edges).not.toContain(
      `fil:${REPO}:infra/terraform/readme.md PART_OF svc:${REPO}:packages/payments`,
    )
    expect(
      out.extractedClaims.every((c) =>
        isConventionalEvidenceSourceId(c.sourceId, REPO, "abc"),
      ),
    ).toBe(true)
  })

  it("reads only changed READMEs on a partial ingest", async () => {
    const out = await extractReadmeDocuments(
      state({
        ingestMode: "partial",
        changedPaths: [
          "packages/payments/src/ledger/README.md",
          "packages/payments/src/ledger/post.ts",
        ],
      }),
    )

    expect(fetchedPaths).toEqual(["packages/payments/src/ledger/README.md"])
    expect(
      out.extractedObjects.filter((o) => o.kind === "Document"),
    ).toHaveLength(1)
  })

  it("does not call codesearch for a deletes-only diff", async () => {
    server.use(
      http.post(`${CODESEARCH}/${REPO}/glob`, () => HttpResponse.error()),
    )

    const out = await extractReadmeDocuments(
      state({
        ingestMode: "partial",
        changedPaths: [],
        deletedPaths: ["packages/payments/README.md"],
      }),
    )

    expect(out).toEqual({ extractedObjects: [], extractedClaims: [] })
  })

  it("keeps the shallowest READMEs when a repository exceeds the cap", async () => {
    files = { "README.md": "# Root\n\nTop.\n" }
    for (let i = 0; i < 2_000; i++) {
      files[`fixtures/cases/${i}/README.md`] = `# Case ${i}\n`
    }

    const out = await withLogger(createLogger({ test: "readme-cap" }), () =>
      extractReadmeDocuments(state()),
    )

    const paths = out.extractedObjects
      .filter((o) => o.kind === "Document")
      .map((d) => d.payload?.path)
    expect(paths).toHaveLength(2_000)
    expect(paths[0]).toBe("README.md")
  })
})
