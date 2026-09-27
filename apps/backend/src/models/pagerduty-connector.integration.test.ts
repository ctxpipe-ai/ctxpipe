import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Env } from "../config/env.js"
import { backfillMissingPagerdutyConnectionDirectory } from "../db/backfill-pagerduty-connection-directory.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import {
  CONNECTION_TYPE_PAGERDUTY,
  connectionDirectory,
  connections,
} from "../db/schema/connections.js"
import { generateObjectId } from "../lib/id.js"
import { getConnectionDirectoryByConnectionId } from "./connection-directory.js"
import { listPagerdutyConnectionsByWebhookSubscriptionId } from "./pagerduty-connector.js"

const execFileAsync = promisify(execFile)
const __dirname = fileURLToPath(new URL(".", import.meta.url))
const backendRoot = resolve(__dirname, "../..")
config({ path: resolve(__dirname, "../../.env.local") })

const connectionString = process.env.DATABASE_URL
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_pd_directory_${suffix}`
const otherOrgId = `org_test_pd_directory_other_${suffix}`
const connectionId = generateObjectId("con")
const otherConnectionId = generateObjectId("con")
const webhookSubscriptionId = `PFSUB_${suffix}`
const env = {
  AUTH_SECRET: "test-secret-at-least-32-characters-long-xx",
} as Env

function historicalPagerdutyConfig() {
  return {
    accountId: "PDACCT",
    accountName: "Acme PD",
    accountSubdomain: "acme",
    region: "us" as const,
    ownerUserId: "user_pd_hist",
    status: "installed",
    webhookSubscriptionId,
    setupPhase: "live",
    enabled: true,
  }
}

describe.skipIf(!connectionString)(
  "PagerDuty webhook directory backfill (Postgres)",
  () => {
    beforeAll(async () => {
      if (!connectionString) return
      initDb(connectionString)
      await getSystemDb()
        .insert(organizations)
        .values([
          {
            id: orgId,
            name: "PagerDuty directory backfill",
            slug: `pd-directory-${suffix}`,
            createdAt: new Date(),
          },
          {
            id: otherOrgId,
            name: "PagerDuty directory other org",
            slug: `pd-directory-other-${suffix}`,
            createdAt: new Date(),
          },
        ])
      await withOrgDbContext(orgId, (db) =>
        db.insert(connections).values({
          id: connectionId,
          orgId,
          type: CONNECTION_TYPE_PAGERDUTY,
          config: historicalPagerdutyConfig(),
        }),
      )
      await withOrgDbContext(otherOrgId, (db) =>
        db.insert(connections).values({
          id: otherConnectionId,
          orgId: otherOrgId,
          type: CONNECTION_TYPE_PAGERDUTY,
          config: {
            ...historicalPagerdutyConfig(),
            accountId: "PDOTHER",
            webhookSubscriptionId: `PFSUB_OTHER_${suffix}`,
          },
        }),
      )
    })

    afterAll(async () => {
      if (!connectionString) return
      await getSystemDb()
        .delete(connectionDirectory)
        .where(eq(connectionDirectory.orgId, orgId))
      await getSystemDb()
        .delete(connectionDirectory)
        .where(eq(connectionDirectory.orgId, otherOrgId))
      await withOrgDbContext(orgId, (db) =>
        db.delete(connections).where(eq(connections.id, connectionId)),
      )
      await withOrgDbContext(otherOrgId, (db) =>
        db.delete(connections).where(eq(connections.id, otherConnectionId)),
      )
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, orgId))
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, otherOrgId))
      await closeDb()
    })

    it("repairs historical PagerDuty rows so webhook lookup finds them without a tenant scan", async () => {
      await expect(
        getConnectionDirectoryByConnectionId(connectionId),
      ).resolves.toBeUndefined()
      await expect(
        listPagerdutyConnectionsByWebhookSubscriptionId({
          webhookSubscriptionId,
          env,
        }),
      ).resolves.toEqual([])

      const inserted = await backfillMissingPagerdutyConnectionDirectory({
        orgId,
      })
      expect(inserted).toBe(1)

      await expect(
        getConnectionDirectoryByConnectionId(connectionId),
      ).resolves.toMatchObject({
        connectionId,
        orgId,
        type: CONNECTION_TYPE_PAGERDUTY,
      })
      await expect(
        getConnectionDirectoryByConnectionId(otherConnectionId),
      ).resolves.toBeUndefined()

      const found = await listPagerdutyConnectionsByWebhookSubscriptionId({
        webhookSubscriptionId,
        env,
      })
      expect(found.map((row) => row.id)).toEqual([connectionId])

      await expect(
        backfillMissingPagerdutyConnectionDirectory({ orgId }),
      ).resolves.toBe(0)

      await execFileAsync(
        "pnpm",
        [
          "exec",
          "tsx",
          "src/db/backfill-pagerduty-connection-directory-cli.ts",
        ],
        {
          cwd: backendRoot,
          env: { ...process.env, DATABASE_URL: connectionString },
        },
      )
      await expect(
        getConnectionDirectoryByConnectionId(otherConnectionId),
      ).resolves.toMatchObject({
        connectionId: otherConnectionId,
        orgId: otherOrgId,
        type: CONNECTION_TYPE_PAGERDUTY,
      })
    })
  },
)
