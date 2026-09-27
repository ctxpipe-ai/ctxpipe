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
  patchGithubPrMirror,
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
      await getSystemDb()
        .insert(organizations)
        .values({
          id: orgId,
          name: "PR mirror integration",
          slug: `pr-mirror-integration-${suffix}`,
          createdAt: new Date(),
        })
      await withOrgDbContext(orgId, (db) =>
        db.insert(connections).values({
          id: connectionId,
          orgId,
          type: CONNECTION_TYPE_GITHUB,
          config: {
            ingestAllRepositories: false,
            includeFutureRepos: false,
          },
        }),
      )
    })

    afterAll(async () => {
      if (!connectionString) return
      await withOrgDbContext(orgId, async (db) => {
        await db.delete(repositories).where(eq(repositories.orgId, orgId))
        await db.delete(connections).where(eq(connections.id, connectionId))
      })
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, orgId))
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

    it("assigns launch ownership in the helper and keeps the same identity pending", async () => {
      await withOrgDbContext(orgId, async () => {
        const first = await patchGithubPrMirror({
          orgId,
          connectionId,
          reserveContentLaunch: true,
          patch: {
            lastContentCommitSha: "sha_a",
            lastContentLaunchToken: null,
          },
        })
        const again = await patchGithubPrMirror({
          orgId,
          connectionId,
          reserveContentLaunch: true,
          patch: {
            lastContentCommitSha: "sha_a",
            lastContentLaunchToken: null,
          },
        })
        const next = await patchGithubPrMirror({
          orgId,
          connectionId,
          reserveContentLaunch: true,
          patch: {
            lastContentCommitSha: "sha_b",
            lastContentLaunchToken: null,
          },
        })
        const retried = await patchGithubPrMirror({
          orgId,
          connectionId,
          reserveContentLaunch: true,
          patch: {
            lastContentCommitSha: "sha_b",
            lastContentLaunchToken: "tok_retry",
          },
        })

        expect(first.applied).toBe(true)
        expect(again.contentSyncGeneration).toBe(first.contentSyncGeneration)
        expect(next.contentSyncGeneration).toBe(first.contentSyncGeneration + 1)
        expect(retried.contentSyncGeneration).toBe(
          next.contentSyncGeneration + 1,
        )
        await expect(
          getGithubPrMirrorBinding(orgId, connectionId),
        ).resolves.toMatchObject({
          lastContentCommitSha: "sha_b",
          lastContentLaunchToken: "tok_retry",
          contentSyncGeneration: retried.contentSyncGeneration,
        })
      })
    })

    it("bumps generation on rebind so an old content run cannot own the new target", async () => {
      const firstRepositoryId = await withOrgDbContext(orgId, async () =>
        resolveGithubPrMirrorRepository({
          orgId,
          connectionId,
          repositoryName: "acme/ctxpipe-context-r1",
          gitUrl: `https://github.com/acme/ctxpipe-context-r1-${suffix}.git`,
          branch: "main",
        }),
      )
      const secondRepositoryId = await withOrgDbContext(orgId, async () =>
        resolveGithubPrMirrorRepository({
          orgId,
          connectionId,
          repositoryName: "acme/ctxpipe-context-r2",
          gitUrl: `https://github.com/acme/ctxpipe-context-r2-${suffix}.git`,
          branch: "main",
        }),
      )

      const reserved = await withOrgDbContext(orgId, async () => {
        await bindGithubPrMirror({
          orgId,
          connectionId,
          repositoryId: firstRepositoryId,
          branch: "main",
        })
        return patchGithubPrMirror({
          orgId,
          connectionId,
          reserveContentLaunch: true,
          patch: {
            lastContentCommitSha: "sha_r1",
            lastContentLaunchToken: null,
          },
        })
      })

      const rebound = await withOrgDbContext(orgId, async () =>
        bindGithubPrMirror({
          orgId,
          connectionId,
          repositoryId: secondRepositoryId,
          branch: "main",
        }),
      )

      const staleClaim = await withOrgDbContext(orgId, async () =>
        patchGithubPrMirror({
          orgId,
          connectionId,
          workflowRunId: "run_old",
          claimContentRun: true,
          expectedContentSyncGeneration: reserved.contentSyncGeneration,
          expectedRepositoryId: firstRepositoryId,
          expectedBranch: "main",
          patch: { setupPhase: "initial_sync" },
        }),
      )
      const staleLive = await withOrgDbContext(orgId, async () =>
        patchGithubPrMirror({
          orgId,
          connectionId,
          expectedContentSyncGeneration: reserved.contentSyncGeneration,
          expectedRepositoryId: firstRepositoryId,
          expectedBranch: "main",
          patch: { setupPhase: "live" },
        }),
      )

      expect(rebound).toMatchObject({
        repositoryId: secondRepositoryId,
        contentSyncGeneration: reserved.contentSyncGeneration + 1,
        setupPhase: "draft",
      })
      expect(staleClaim.applied).toBe(false)
      expect(staleLive.applied).toBe(false)
      await expect(
        getGithubPrMirrorBinding(orgId, connectionId),
      ).resolves.toMatchObject({
        repositoryId: secondRepositoryId,
        setupPhase: "draft",
        contentSyncGeneration: rebound.contentSyncGeneration,
      })
    })

    it("lets an ensure-stage claim clear an old marker and refuses a stale ensure failure after a newer launch", async () => {
      await withOrgDbContext(orgId, async () => {
        const claimed = await patchGithubPrMirror({
          orgId,
          connectionId,
          claimEnsureStage: true,
          expectedContentSyncGeneration: (
            await getGithubPrMirrorBinding(orgId, connectionId)
          )?.contentSyncGeneration,
          patch: {
            lastContentCommitSha: null,
            lastContentLaunchToken: null,
          },
        })
        expect(claimed.applied).toBe(true)
        await expect(
          getGithubPrMirrorBinding(orgId, connectionId),
        ).resolves.toMatchObject({
          lastContentCommitSha: null,
          lastContentLaunchToken: null,
          contentSyncGeneration: claimed.contentSyncGeneration,
        })

        const newer = await patchGithubPrMirror({
          orgId,
          connectionId,
          reserveContentLaunch: true,
          patch: {
            lastContentCommitSha: "sha_b",
            lastContentLaunchToken: "tok_b",
          },
        })
        expect(newer.contentSyncGeneration).toBe(
          claimed.contentSyncGeneration + 1,
        )

        const staleFailure = await patchGithubPrMirror({
          orgId,
          connectionId,
          expectedContentSyncGeneration: claimed.contentSyncGeneration,
          patch: { setupPhase: "sync_failed" },
        })
        expect(staleFailure.applied).toBe(false)
        await expect(
          getGithubPrMirrorBinding(orgId, connectionId),
        ).resolves.toMatchObject({
          lastContentCommitSha: "sha_b",
          lastContentLaunchToken: "tok_b",
          contentSyncGeneration: newer.contentSyncGeneration,
        })
      })
    })

    it("supersedes a retained legacy claim after a reserved identity is live", async () => {
      await withOrgDbContext(orgId, async () => {
        const reserved = await patchGithubPrMirror({
          orgId,
          connectionId,
          reserveContentLaunch: true,
          patch: {
            lastContentCommitSha: "sha_b",
            lastContentLaunchToken: "tok_b",
          },
        })
        const live = await patchGithubPrMirror({
          orgId,
          connectionId,
          workflowRunId: "run_b",
          claimContentRun: true,
          expectedContentSyncGeneration: reserved.contentSyncGeneration,
          patch: { setupPhase: "live" },
        })
        expect(live.applied).toBe(true)

        const legacyA = await patchGithubPrMirror({
          orgId,
          connectionId,
          workflowRunId: "run_legacy_a",
          claimContentRun: true,
          patch: { setupPhase: "initial_sync" },
        })
        expect(legacyA.applied).toBe(false)
        expect(legacyA.contentSyncGeneration).toBe(
          reserved.contentSyncGeneration,
        )
        await expect(
          getGithubPrMirrorBinding(orgId, connectionId),
        ).resolves.toMatchObject({
          lastContentCommitSha: "sha_b",
          lastContentLaunchToken: "tok_b",
          setupPhase: "live",
          contentSyncGeneration: reserved.contentSyncGeneration,
        })
      })
    })
  },
)
