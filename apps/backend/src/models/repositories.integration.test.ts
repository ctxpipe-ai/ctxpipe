import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenAPIHono } from "@hono/zod-openapi"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { contextStorage } from "hono/context-storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AppEnv } from "../app/env.js"
import { withOrgIdContext } from "../auth/withAuth.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { repositories } from "../db/schema/repositories.js"
import { generateObjectId } from "../lib/id.js"
import {
  markRepositoryIndexingRunning,
  repositoryIngestionBlockedByDeletion,
  setRepositoryIndexingStep,
  tryClaimRepositoryIndexingEnqueue,
} from "./repositories.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const connectionString = process.env.DATABASE_URL
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_repo_guard_${suffix}`
const orgSlug = `repo-guard-${suffix}`

describe.skipIf(!connectionString)(
  "repository ingestion guards (Postgres)",
  () => {
    const unindexingId = generateObjectId("repo")
    const liveId = generateObjectId("repo")

    beforeAll(async () => {
      if (!connectionString) return
      initDb(connectionString)
      await getSystemDb().insert(organizations).values({
        id: orgId,
        name: "Repository guard integration",
        slug: orgSlug,
        createdAt: new Date(),
      })
      await withOrgDbContext(orgId, async (db) => {
        await db.insert(repositories).values([
          {
            id: unindexingId,
            orgId,
            name: `acme/unindexing-${suffix}`,
            gitUrl: `https://github.com/acme/unindexing-${suffix}.git`,
            indexReady: false,
            indexingStatus: "unindexing",
            indexingStep: 4,
            indexingStepKey: "cloning",
          },
          {
            id: liveId,
            orgId,
            name: `acme/live-${suffix}`,
            gitUrl: `https://github.com/acme/live-${suffix}.git`,
            indexReady: false,
          },
        ])
      })
    })

    afterAll(async () => {
      if (!connectionString) return
      const db = getSystemDb()
      await db.delete(repositories).where(eq(repositories.orgId, orgId))
      await db.delete(organizations).where(eq(organizations.id, orgId))
      await closeDb()
    })

    async function readStatus(repositoryId: string) {
      const [row] = await getSystemDb()
        .select({
          indexingStatus: repositories.indexingStatus,
          indexingStep: repositories.indexingStep,
          indexingStepKey: repositories.indexingStepKey,
        })
        .from(repositories)
        .where(eq(repositories.id, repositoryId))
        .limit(1)
      return row
    }

    it("does not resurrect a repository that is unindexing", async () => {
      await withOrgDbContext(orgId, () =>
        markRepositoryIndexingRunning({ repositoryId: unindexingId }),
      )
      await withOrgDbContext(orgId, () =>
        setRepositoryIndexingStep({
          repositoryId: unindexingId,
          key: "resolving_ref",
        }),
      )

      await expect(readStatus(unindexingId)).resolves.toEqual({
        indexingStatus: "unindexing",
        indexingStep: 4,
        indexingStepKey: "cloning",
      })
      await expect(
        withOrgDbContext(orgId, () =>
          tryClaimRepositoryIndexingEnqueue({
            repositoryId: unindexingId,
            reason: "webhook",
          }),
        ),
      ).resolves.toBe(false)
      await expect(readStatus(unindexingId)).resolves.toMatchObject({
        indexingStatus: "unindexing",
      })
      await expect(
        repositoryIngestionBlockedByDeletion({
          orgId,
          repositoryId: unindexingId,
        }),
      ).resolves.toBe(true)
      await expect(
        repositoryIngestionBlockedByDeletion({
          orgId,
          repositoryId: "repo_missing",
        }),
      ).resolves.toBe(true)
    })

    it("still updates a repository that is not being deleted", async () => {
      await expect(
        repositoryIngestionBlockedByDeletion({
          orgId,
          repositoryId: liveId,
        }),
      ).resolves.toBe(false)
      await withOrgDbContext(orgId, () =>
        markRepositoryIndexingRunning({ repositoryId: liveId }),
      )
      await expect(readStatus(liveId)).resolves.toMatchObject({
        indexingStatus: "running",
      })
    })

    it("returns the same repository with 201 then 200 for one git URL", async () => {
      const { repositoryRoutes } = await import("../routes/v1/repositories.js")
      const gitUrl = `https://github.com/acme/idempotent-${suffix}.git`
      const app = new OpenAPIHono<AppEnv>()
      app.use(contextStorage())
      app.use("*", async (c, next) => {
        c.set("user", { id: "user_test" } as AppEnv["Variables"]["user"])
        c.set("session", { id: "sess_test" } as AppEnv["Variables"]["session"])
        c.set("log", {
          error: () => {},
          info: () => {},
          warn: () => {},
          debug: () => {},
          child: () => c.get("log"),
        } as unknown as AppEnv["Variables"]["log"])
        return withOrgIdContext({ id: orgId, slug: orgSlug }, () =>
          withOrgDbContext(orgId, () => next()),
        )
      })
      app.route("/repositories", repositoryRoutes)

      const post = () =>
        app.request("/repositories", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `acme/idempotent-${suffix}`,
            gitUrl,
          }),
        })

      const created = await post()
      const createdText = await created.text()
      expect(created.status, createdText).toBe(201)
      const createdBody = JSON.parse(createdText) as { id: string }

      const again = await post()
      const againText = await again.text()
      expect(again.status, againText).toBe(200)
      const againBody = JSON.parse(againText) as { id: string }
      expect(againBody.id).toBe(createdBody.id)
    })
  },
)
