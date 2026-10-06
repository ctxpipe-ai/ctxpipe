/**
 * A partial ingest that edits a workflow runs without the repository's
 * packages in state, after retraction removed the workflow's edges. The
 * extractor must rebuild them from the packages already on the graph, and
 * open its own org DB scope to read them: `repository-ingestion` runs the
 * identify step inside the org id context but outside `withOrgDbContext`.
 *
 * Requires DATABASE_URL (apps/backend/.env.local). Skipped otherwise.
 */
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { useMswServer } from "../../../../test/msw.js"
import { withOrgIdContext } from "../../../auth/withAuth.js"
import { closeDb, getSystemDb, initDb } from "../../../db/client.js"
import { objects } from "../../../db/schema/objects.js"
import { generateObjectId } from "../../../lib/id.js"
import { extractGithubWorkflows } from "./extractGithubWorkflows.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../../.env.local") })

const connectionString = process.env.DATABASE_URL

const ORG_ID = `org_test_workflows_${Date.now()}`
const REPO_ID = generateObjectId("repo")
const WORKFLOW = `on:
  push:
    paths: ["apps/backend/**", "apps/backend/plugins/billing/**"]
jobs:
  test:
    defaults:
      run:
        working-directory: apps/ui
`

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()

describe.skipIf(!connectionString)(
  "extractGithubWorkflows on a partial ingest (Postgres)",
  () => {
    beforeAll(async () => {
      if (!connectionString) return
      initDb(connectionString)
      await getSystemDb()
        .insert(objects)
        .values(
          [
            ["Service", `svc:${REPO_ID}:apps/backend`],
            ["Service", `svc:${REPO_ID}:apps/backend/plugins/billing`],
            ["App", `app:${REPO_ID}:apps/ui`],
          ].map(([kind, deduplicationKey]) => ({
            id: generateObjectId("obj"),
            orgId: ORG_ID,
            kind: kind as string,
            deduplicationKey,
            payload: {},
          })),
        )
    })

    afterAll(async () => {
      if (!connectionString) return
      try {
        await getSystemDb().delete(objects).where(eq(objects.orgId, ORG_ID))
      } finally {
        await closeDb()
      }
    })

    it("rebuilds MENTIONS from the packages on the graph, longest root first", async () => {
      vi.stubEnv(
        "AUTH_SECRET",
        "test-only-auth-secret-with-at-least-32-characters",
      )
      vi.stubEnv("CODESEARCH_URL", "http://codesearch.test")
      server.use(
        http.post(
          `http://codesearch.test/${REPO_ID}/glob`,
          async ({ request }) => {
            const { pattern } = (await request.json()) as { pattern: string }
            const entries = pattern.endsWith(".yml")
              ? [
                  {
                    name: "ci.yml",
                    path: ".github/workflows/ci.yml",
                    type: "file",
                  },
                ]
              : []
            return HttpResponse.json({ entries, truncated: false, matched: 0 })
          },
        ),
        http.post(`http://codesearch.test/${REPO_ID}/files-query`, () =>
          HttpResponse.json({
            ".github/workflows/ci.yml":
              Buffer.from(WORKFLOW).toString("base64"),
          }),
        ),
      )

      const result = await withOrgIdContext(
        { id: ORG_ID, slug: "workflows" },
        () =>
          extractGithubWorkflows({
            repositoryId: REPO_ID,
            orgId: ORG_ID,
            targetHash: "abc",
            ingestMode: "partial",
            changedPaths: [".github/workflows/ci.yml"],
            roots: ["./"],
            extractedObjects: [],
            extractedClaims: [],
            objectIds: [],
            touchedObjectIds: [],
            claimsForProjection: [],
          }),
      )
      vi.unstubAllEnvs()

      expect(
        (result.extractedClaims ?? []).map((claim) => claim.objectRef).sort(),
      ).toEqual([
        `app:${REPO_ID}:apps/ui`,
        `svc:${REPO_ID}:apps/backend`,
        `svc:${REPO_ID}:apps/backend/plugins/billing`,
      ])
    })
  },
)
