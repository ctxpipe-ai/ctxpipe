import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest"
import { describeWithDatabase } from "../../../../test/db.js"
import { useMswServer } from "../../../../test/msw.js"
import { closeDb, getSystemDb, initDb } from "../../../db/client.js"
import { objects } from "../../../db/schema/objects.js"
import { generateObjectId } from "../../../lib/id.js"
import { extractReadmeDocuments } from "./extractReadmeDocuments.js"

const CODESEARCH = "http://codesearch.test"
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const ORG = `org_test_readme_${suffix}`
const REPO = `repo_readme_${suffix}`
const LEDGER = "packages/payments/src/ledger/README.md"
const files: Record<string, string> = {
  "packages/payments/README.md": "# Payments\n\nCharges cards.\n",
  [LEDGER]: "# Ledger\n\nDouble-entry postings.\n",
}

useMswServer(
  http.post(`${CODESEARCH}/${REPO}/glob`, () =>
    HttpResponse.json({
      entries: Object.keys(files).map((path) => ({
        name: "README.md",
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

describeWithDatabase("extractReadmeDocuments on a push (Postgres)", () => {
  beforeAll(async () => {
    initDb(process.env.DATABASE_URL as string)
    await getSystemDb()
      .insert(objects)
      .values({
        id: generateObjectId("obj"),
        orgId: ORG,
        kind: "Service",
        deduplicationKey: `svc:${REPO}:packages/payments`,
        payload: {},
      })
  })
  afterAll(async () => {
    await getSystemDb().delete(objects).where(eq(objects.orgId, ORG))
    await closeDb()
  })
  beforeEach(() => {
    vi.stubEnv("CODESEARCH_URL", CODESEARCH)
    vi.stubEnv("AUTH_SECRET", "x".repeat(32))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("re-reads only the changed README and keeps its package link from the graph", async () => {
    // A push that touches no manifest re-extracts no package objects.
    const out = await extractReadmeDocuments({
      repositoryId: REPO,
      orgId: ORG,
      targetHash: "abc",
      ingestMode: "partial",
      changedPaths: [LEDGER, "packages/payments/src/ledger/post.ts"],
      roots: ["packages/payments"],
      extractedObjects: [],
      extractedClaims: [],
      objectIds: [],
      touchedObjectIds: [],
      claimsForProjection: [],
    })

    expect(
      out.extractedObjects
        .filter((o) => o.kind === "Document")
        .map((d) => d.payload?.path),
    ).toEqual([LEDGER])
    expect(
      out.extractedClaims.map(
        (c) => `${c.subjectRef} ${c.predicate} ${c.objectRef}`,
      ),
    ).toContain(`fil:${REPO}:${LEDGER} PART_OF svc:${REPO}:packages/payments`)
  })
})
