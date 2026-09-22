import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import {
  CONNECTION_TYPE_GITHUB,
  connections,
} from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { generateObjectId } from "../lib/id.js"
import {
  bindGithubPrMirror,
  getGithubPrMirrorBinding,
  resolveGithubPrMirrorRepository,
} from "./github-pr-mirror.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const connectionString = process.env.DATABASE_URL
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_pr_mirror_${suffix}`
const connectionId = generateObjectId("con")

describe.skipIf(!connectionString)(
  "GitHub PR mirror binding (Postgres)",
  () => {
    beforeAll(async () => {
      if (!connectionString) return
      initDb(connectionString)
      const db = getSystemDb()
      await db.insert(organizations).values({
        id: orgId,
        name: "PR mirror integration",
        slug: `pr-mirror-integration-${suffix}`,
        createdAt: new Date(),
      })
      await db.insert(connections).values({
        id: connectionId,
        orgId,
        type: CONNECTION_TYPE_GITHUB,
        config: {
          ingestAllRepositories: false,
          includeFutureRepos: false,
        },
      })
    })

    afterAll(async () => {
      if (!connectionString) return
      const db = getSystemDb()
      await db.delete(repositories).where(eq(repositories.orgId, orgId))
      await db.delete(organizations).where(eq(organizations.id, orgId))
      await closeDb()
    })

    it("binds a context repository before the creating transaction commits", async () => {
      const repositoryId = await withOrgDbContext(orgId, async () => {
        const createdRepositoryId = await resolveGithubPrMirrorRepository({
          orgId,
          connectionId,
          repositoryName: "acme/ctxpipe-context",
          gitUrl: `https://github.com/acme/ctxpipe-context-${suffix}.git`,
          branch: "main",
        })
        const binding = await bindGithubPrMirror({
          orgId,
          connectionId,
          repositoryId: createdRepositoryId,
          branch: "main",
        })

        expect(binding.repositoryId).toBe(createdRepositoryId)
        return createdRepositoryId
      })

      await expect(
        getGithubPrMirrorBinding(orgId, connectionId),
      ).resolves.toMatchObject({
        repositoryId,
        repositoryName: "acme/ctxpipe-context",
        branch: "main",
        enabled: true,
        setupPhase: "draft",
      })
    })
  },
)
