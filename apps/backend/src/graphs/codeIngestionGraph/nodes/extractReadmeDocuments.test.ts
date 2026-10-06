import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useMswServer } from "../../../../test/msw.js"
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

const server = useMswServer(
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

function state(): CodeIngestionState {
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
  }
}

function documents(out: Awaited<ReturnType<typeof extractReadmeDocuments>>) {
  return out.extractedObjects.filter((o) => o.kind === "Document")
}

beforeEach(() => {
  vi.stubEnv("CODESEARCH_URL", CODESEARCH)
  vi.stubEnv("AUTH_SECRET", "x".repeat(32))
  vi.stubEnv("DATABASE_URL", "postgresql://unused@localhost/unused")
  files = {
    "README.md": "# Monorepo\n\nEverything the company ships.\n",
    "packages/payments/README.md": "# Payments\n\nCharges cards.\n",
    "packages/payments/src/ledger/README.md":
      "# Ledger\n\nDouble-entry postings, reconciled nightly.\n\n## Gotchas\n\nNever edit a posted entry.\n",
    "infra/terraform/README.MD": "Terraform for the shared network.\n",
    "docs/empty/README.md": "  \n",
    "node_modules/left-pad/README.md": "# left-pad\n",
    "notion/engineering/README.md": "# Mirrored page\n",
  }
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("parseReadmeMarkdown", () => {
  it("takes the first H1 as title and skips badges and HTML for the summary", () => {
    expect(
      parseReadmeMarkdown(
        '[![ci](https://ci.example/badge.svg)](https://ci.example)\n\n# Ledger\n\n<p align="center"><img src="logo.png"></p>\n\nDouble-entry postings.\n',
        "src/ledger/README.md",
      ),
    ).toMatchObject({ title: "Ledger", summary: "Double-entry postings." })
  })

  it("falls back to frontmatter title, then the directory, then the file name", () => {
    expect(
      parseReadmeMarkdown("---\ntitle: Billing\n---\nBody.\n", "x/README.md"),
    ).toMatchObject({ title: "Billing", summary: "Body." })
    expect(
      parseReadmeMarkdown("Just prose.\n", "infra/terraform/README.md"),
    ).toMatchObject({ title: "infra/terraform" })
    expect(parseReadmeMarkdown("Just prose.\n", "README.md")).toMatchObject({
      title: "README.md",
    })
  })

  it("returns null for an empty file", () => {
    expect(parseReadmeMarkdown(" \n", "README.md")).toBeNull()
  })
})

describe("extractReadmeDocuments", () => {
  it("makes every README a Document located in its package or the repository", async () => {
    const out = await extractReadmeDocuments(state())

    expect(documents(out).map((d) => d.payload?.path)).toEqual([
      "README.md",
      "infra/terraform/README.MD",
      "packages/payments/README.md",
      "packages/payments/src/ledger/README.md",
    ])
    expect(
      documents(out).find(
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
        `doc:${REPO}:infra/terraform/README.MD DECLARED_IN fil:${REPO}:infra/terraform/README.MD`,
        `fil:${REPO}:infra/terraform/README.MD PART_OF ${REPO}`,
      ]),
    )
    expect(edges).not.toContain(
      `fil:${REPO}:infra/terraform/README.MD PART_OF svc:${REPO}:packages/payments`,
    )
    expect(
      out.extractedClaims.every((c) =>
        isConventionalEvidenceSourceId(c.sourceId, REPO, "abc"),
      ),
    ).toBe(true)
  })

  it("never cuts an emoji in half at the excerpt limit", async () => {
    files = { "README.md": `# Root\n\n${"a".repeat(1_999)}🚀 tail\n` }

    const [document] = documents(await extractReadmeDocuments(state()))

    expect(document?.payload?.excerpt).toBe("a".repeat(1_999))
  })

  it("does not call codesearch for a deletes-only diff", async () => {
    server.use(
      http.post(`${CODESEARCH}/${REPO}/glob`, () => HttpResponse.error()),
    )

    const out = await extractReadmeDocuments({
      ...state(),
      ingestMode: "partial",
      changedPaths: [],
      deletedPaths: ["packages/payments/README.md"],
    })

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

    const paths = documents(out).map((d) => d.payload?.path)
    expect(paths).toHaveLength(2_000)
    expect(paths[0]).toBe("README.md")
  })
})
