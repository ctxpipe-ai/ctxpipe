import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { describeWithDatabase } from "../../test/db.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import { generateObjectId } from "../lib/id.js"
import { DEFAULT_CHECKOUT_KEY } from "../models/repositories.js"
import {
  type RepositoryIngestionChildStep,
  runConnectorRepositoryIngestionWorkflow,
} from "./enqueue-repository-ingestion.js"

const connectionString = process.env.DATABASE_URL
const orgId = generateObjectId("org")
const repositoryId = generateObjectId("repo")
const codesearchUrl = "http://codesearch.test"
const codesearch = setupServer(
  http.post(`${codesearchUrl}/${repositoryId}/resolve-ref`, () =>
    HttpResponse.json({ branch: "main", hash: "sha_current" }),
  ),
)

describeWithDatabase(
  "runConnectorRepositoryIngestionWorkflow logger contract",
  () => {
    beforeAll(() => {
      codesearch.listen({ onUnhandledRequest: "error" })
    })
    afterEach(() => {
      codesearch.resetHandlers()
    })
    afterAll(() => {
      codesearch.close()
    })

    beforeAll(async () => {
      if (!connectionString) throw new Error("DATABASE_URL is unset")
      vi.stubEnv("AUTH_SECRET", "ci-auth-secret-must-be-at-least-32-chars")
      vi.stubEnv("CODESEARCH_URL", codesearchUrl)
      initDb(connectionString)
      await getSystemDb()
        .insert(organizations)
        .values({
          id: orgId,
          name: "Connector ingestion logger",
          slug: `ingest-logger-${orgId}`,
          createdAt: new Date(),
        })
      await withOrgDbContext(orgId, async (db) => {
        await db.insert(repositories).values({
          id: repositoryId,
          orgId,
          name: `acme/ingest-logger-${orgId}`,
          gitUrl: `https://github.com/acme/ingest-logger-${orgId}.git`,
          lastIngestedHash: "sha_previous",
          indexingStatus: "ready",
        })
        await db.insert(repositoryCheckouts).values({
          id: generateObjectId("co"),
          orgId,
          repositoryId,
          ref: "main",
          checkoutKey: DEFAULT_CHECKOUT_KEY,
        })
      })
    })

    afterAll(async () => {
      vi.unstubAllEnvs()
      if (!connectionString) return
      await withOrgDbContext(orgId, (db) =>
        db.delete(repositories).where(eq(repositories.id, repositoryId)),
      )
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, orgId))
      await closeDb()
    })

    it("runs outside a pre-existing request or workflow logger context", async () => {
      const step = {
        run: vi.fn(
          async (
            _options: { name: string },
            operation: () => Promise<unknown>,
          ) => operation(),
        ),
        runWorkflow: vi.fn().mockResolvedValue(undefined),
        sleep: vi.fn(),
      } as unknown as RepositoryIngestionChildStep

      await expect(
        runConnectorRepositoryIngestionWorkflow(
          step,
          {
            repositoryId,
            orgId,
            targetBranch: "main",
            indexingReason: "Syncing connector content",
          },
          { error: vi.fn() },
        ),
      ).resolves.toBeUndefined()

      expect(step.runWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ name: "repository-ingestion-orchestrator" }),
        expect.objectContaining({
          repositoryId,
          orgId,
        }),
        { name: `ingest-${repositoryId}` },
      )
    })
  },
)
