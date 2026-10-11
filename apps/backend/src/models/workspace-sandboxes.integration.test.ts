import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { closeDb, initDb, withOrgDbContext } from "../db/client.js"
import { workspaces } from "../db/schema/workspaces.js"
import {
  listSandboxInstances,
  persistSandboxInstance,
} from "./workspace-sandboxes.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const connectionString = process.env.DATABASE_URL
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgs = [
  `org_test_sandboxes_a_${suffix}`,
  `org_test_sandboxes_b_${suffix}`,
]

describe("sandbox instances (Postgres)", () => {
  beforeAll(async () => {
    if (!connectionString) throw new Error("DATABASE_URL is required")
    initDb(connectionString)
    for (const [index, orgId] of orgs.entries()) {
      const workspaceId = `ws_test_sandboxes_${index}_${suffix}`
      await withOrgDbContext(orgId, (db) =>
        db.insert(workspaces).values({
          id: workspaceId,
          orgId,
          slug: `sandboxes-${index}-${suffix}`,
          displayName: "Sandboxes",
          workspaceRepositoryUrl: `/tmp/sandboxes-${suffix}`,
          desiredDefaultBranch: "main",
          writeStatus: "read_only",
        }),
      )
      await persistSandboxInstance({
        id: `sandbox_${index}_${suffix}`,
        kind: "chat",
        orgId,
        workspaceId,
        conversationId: `conv_test_sandboxes_${index}_${suffix}`,
        state: "live",
        lastHeartbeatAt: new Date(),
      })
    }
  })

  afterAll(async () => {
    for (const orgId of orgs)
      await withOrgDbContext(orgId, (db) =>
        db.delete(workspaces).where(eq(workspaces.orgId, orgId)),
      )
    await closeDb()
  })

  // The owner role used by local development and migrations skips row-level
  // security, so the org filter must be in the query too: the sweep deletes
  // each sandbox it lists whose conversation its org does not have.
  it("lists only the org's own sandboxes, also for a role that skips row-level security", async () => {
    const [orgId] = orgs
    if (!orgId) throw new Error("no org")
    const rows = await withOrgDbContext(orgId, () =>
      listSandboxInstances({ kind: "chat" }),
    )
    expect(rows.map((row) => row.id)).toEqual([`sandbox_0_${suffix}`])
  })
})
