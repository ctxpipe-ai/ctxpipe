import { eq, sql } from "drizzle-orm"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withOrgIdContext } from "../auth/withAuth.js"
import {
  getConnectionDirectoryByConnectionId,
  listConnectionDirectoryByGithubInstallationId,
  loadConnectionViaDirectory,
  upsertConnectionDirectory,
} from "../models/connection-directory.js"
import { deleteWorkspace, getWorkspaceBySlug } from "../models/workspaces.js"
import { assertSeededRlsCanary } from "./assert-rls-canary.js"
import { assertRuntimeRoleDoesNotBypassRls } from "./assert-runtime-role.js"
import {
  closeDb,
  getOrgDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "./client.js"
import { organizations } from "./schema/auth.js"
import {
  CONNECTION_TYPE_GITHUB,
  connectionDirectory,
  connections,
} from "./schema/connections.js"
import { workspaces } from "./schema/workspaces.js"

const TENANT_RLS_TABLES = [
  "workspaces",
  "workspace_linked_repositories",
  "workspace_knowledge_units",
  "org_member_preferences",
  "workspace_write_jobs",
  "workspace_sandbox_instances",
  "connections",
  "repositories",
  "repository_checkouts",
  "objects",
  "conversations",
  "conversation_messages",
  "confluence_sync_targets",
  "confluence_spaces",
  "claims",
  "claim_evidence",
  "org_onboarding",
] as const

const UNRLS_TABLES = [
  "connection_directory",
  "organizations",
  "members",
  "invitations",
] as const

const runId = `rls_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
const orgA = {
  id: `${runId}_a`,
  slug: `${runId}-a`,
  name: "RLS org A",
}
const orgB = {
  id: `${runId}_b`,
  slug: `${runId}-b`,
  name: "RLS org B",
}
const githubInstallationId = String(800_000 + Math.floor(Math.random() * 1000))
const connectionAId = `con_${runId}_a`

function workspaceValues(
  orgId: string,
  suffix: string,
): typeof workspaces.$inferInsert {
  return {
    id: `ws_${runId}_${suffix}`,
    orgId,
    slug: `ws-${suffix}`,
    displayName: `Workspace ${suffix}`,
    workspaceRepositoryUrl: `https://github.com/ctxpipe-ai/${runId}-${suffix}`,
  }
}

async function deleteWorkspaceHttpStatus(
  org: { id: string; slug: string },
  slug: string,
  confirmName: string,
): Promise<number> {
  return withOrgIdContext(org, async () => {
    const workspace = await getWorkspaceBySlug(slug)
    if (!workspace) return 404
    if (confirmName !== workspace.displayName) return 400
    const deleted = await deleteWorkspace(slug, confirmName)
    if (!deleted) return 404
    return 204
  })
}

async function catalogFlags(relname: string): Promise<{
  relrowsecurity: boolean
  relforcerowsecurity: boolean
}> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  try {
    const result = await pool.query<{
      relrowsecurity: boolean
      relforcerowsecurity: boolean
    }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1`,
      [relname],
    )
    const row = result.rows[0]
    if (!row) {
      throw new Error(`catalog missing public.${relname}`)
    }
    return row
  } finally {
    await pool.end()
  }
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      "DATABASE_URL is required; run this file as ctxpipe_app after owner migrate",
    )
  }
  initDb(url)
  const now = new Date()
  await getSystemDb()
    .insert(organizations)
    .values([
      { id: orgA.id, name: orgA.name, slug: orgA.slug, createdAt: now },
      { id: orgB.id, name: orgB.name, slug: orgB.slug, createdAt: now },
    ])
})

afterAll(async () => {
  try {
    await withOrgDbContext(orgA.id, async () => {
      await getOrgDb().delete(workspaces).where(eq(workspaces.orgId, orgA.id))
      await getOrgDb().delete(connections).where(eq(connections.orgId, orgA.id))
    })
    await withOrgDbContext(orgB.id, async () => {
      await getOrgDb().delete(workspaces).where(eq(workspaces.orgId, orgB.id))
      await getOrgDb().delete(connections).where(eq(connections.orgId, orgB.id))
    })
    const db = getSystemDb()
    await db
      .delete(connectionDirectory)
      .where(eq(connectionDirectory.orgId, orgA.id))
    await db
      .delete(connectionDirectory)
      .where(eq(connectionDirectory.orgId, orgB.id))
    await db.delete(organizations).where(eq(organizations.id, orgA.id))
    await db.delete(organizations).where(eq(organizations.id, orgB.id))
  } finally {
    await closeDb()
  }
})

describe("boot role and seeded canary", () => {
  it("refuses BYPASSRLS and current_user is ctxpipe_app", async () => {
    await expect(
      assertRuntimeRoleDoesNotBypassRls(process.env.DATABASE_URL),
    ).resolves.toBeUndefined()
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    })
    try {
      const result = await pool.query<{
        rolname: string
        rolbypassrls: boolean
      }>(
        `SELECT rolname, rolbypassrls
         FROM pg_catalog.pg_roles
         WHERE rolname = current_user`,
      )
      expect(result.rows[0]?.rolname).toBe("ctxpipe_app")
      expect(result.rows[0]?.rolbypassrls).toBe(false)
    } finally {
      await pool.end()
    }
  })

  it("seeded canary is visible under GUC and SELECT/UPDATE 0 without GUC", async () => {
    await expect(
      assertSeededRlsCanary(process.env.DATABASE_URL),
    ).resolves.toBeUndefined()
  })
})

describe("catalog ENABLE without FORCE", () => {
  it("enables RLS on tenant tables and does not FORCE", async () => {
    for (const relname of TENANT_RLS_TABLES) {
      const flags = await catalogFlags(relname)
      expect(flags, relname).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: false,
      })
    }
  })

  it("leaves directory, organizations, members, and invitations unRLS'd", async () => {
    for (const relname of UNRLS_TABLES) {
      const flags = await catalogFlags(relname)
      expect(flags, relname).toEqual({
        relrowsecurity: false,
        relforcerowsecurity: false,
      })
    }
  })
})

describe("set_config is transaction-local", () => {
  it("clears app.organization_id after COMMIT", async () => {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    })
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.organization_id', $1, true)", [
        orgA.id,
      ])
      const inside = await client.query<{ v: string | null }>(
        "SELECT current_setting('app.organization_id', true) AS v",
      )
      expect(inside.rows[0]?.v).toBe(orgA.id)
      await client.query("COMMIT")
      const after = await client.query<{ v: string | null }>(
        "SELECT current_setting('app.organization_id', true) AS v",
      )
      expect(after.rows[0]?.v ?? "").toBe("")
    } finally {
      client.release()
      await pool.end()
    }
  })
})

describe("two-org isolation", () => {
  it("hides the other org workspace and UPDATE/DELETE 0", async () => {
    const wsA = workspaceValues(orgA.id, "a")
    const wsB = workspaceValues(orgB.id, "b")
    await withOrgDbContext(orgA.id, async (db) => {
      await db.insert(workspaces).values(wsA)
    })
    await withOrgDbContext(orgB.id, async (db) => {
      await db.insert(workspaces).values(wsB)
    })

    const seenByA = await withOrgDbContext(orgA.id, async (db) =>
      db.select({ id: workspaces.id }).from(workspaces),
    )
    const seenByB = await withOrgDbContext(orgB.id, async (db) =>
      db.select({ id: workspaces.id }).from(workspaces),
    )
    expect(seenByA.map((row) => row.id)).toEqual([wsA.id])
    expect(seenByB.map((row) => row.id)).toEqual([wsB.id])

    const updated = await withOrgDbContext(orgA.id, async (db) =>
      db
        .update(workspaces)
        .set({ displayName: "stolen" })
        .where(eq(workspaces.id, wsB.id)),
    )
    expect(updated.rowCount).toBe(0)

    const removed = await withOrgDbContext(orgA.id, async (db) =>
      db.delete(workspaces).where(eq(workspaces.id, wsB.id)),
    )
    expect(removed.rowCount).toBe(0)

    const stillB = await withOrgDbContext(orgB.id, async (db) =>
      db
        .select({ displayName: workspaces.displayName })
        .from(workspaces)
        .where(eq(workspaces.id, wsB.id)),
    )
    expect(stillB).toEqual([{ displayName: wsB.displayName }])
  })

  it("scopes JWT-shaped orgId the same way codesearch SET LOCAL does", async () => {
    const jwtOrg = `${runId}_jwt`
    const ws = workspaceValues(jwtOrg, "jwt")
    await withOrgDbContext(jwtOrg, async (db) => {
      await db.insert(workspaces).values(ws)
    })
    const mine = await withOrgDbContext(jwtOrg, async (db) =>
      db.select({ id: workspaces.id }).from(workspaces),
    )
    const other = await withOrgDbContext(orgA.id, async (db) =>
      db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, ws.id)),
    )
    expect(mine.map((row) => row.id)).toEqual([ws.id])
    expect(other).toEqual([])
    await withOrgDbContext(jwtOrg, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.id, ws.id))
    })
  })
})

describe("connection_directory then org tx", () => {
  it("bootstraps from the unRLS'd directory then loads the tenant connection", async () => {
    const connection = {
      id: connectionAId,
      orgId: orgA.id,
      type: CONNECTION_TYPE_GITHUB,
      config: { installationId: githubInstallationId },
    }
    await withOrgDbContext(orgA.id, async (db) => {
      await db.insert(connections).values(connection)
    })
    await upsertConnectionDirectory(connection)

    const directory = await getConnectionDirectoryByConnectionId(connectionAId)
    expect(directory?.orgId).toBe(orgA.id)
    const listed = await listConnectionDirectoryByGithubInstallationId(
      Number(githubInstallationId),
    )
    expect(listed.map((row) => row.connectionId)).toContain(connectionAId)

    const loaded = await loadConnectionViaDirectory(connectionAId)
    expect(loaded?.id).toBe(connectionAId)
    expect(loaded?.orgId).toBe(orgA.id)

    const hidden = await withOrgDbContext(orgB.id, async (db) =>
      db
        .select({ id: connections.id })
        .from(connections)
        .where(eq(connections.id, connectionAId)),
    )
    expect(hidden).toEqual([])
  })
})

describe("missing GUC fails closed", () => {
  it("SELECT/UPDATE 0 and INSERT is rejected without app.organization_id", async () => {
    const ws = workspaceValues(orgA.id, "noguc")
    await withOrgDbContext(orgA.id, async (db) => {
      await db.insert(workspaces).values(ws)
    })

    const leaked = await getSystemDb()
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, ws.id))
    expect(leaked).toEqual([])

    const updated = await getSystemDb()
      .update(workspaces)
      .set({ displayName: "no-guc" })
      .where(eq(workspaces.id, ws.id))
    expect(updated.rowCount).toBe(0)

    await expect(
      getSystemDb().insert(workspaces).values(workspaceValues(orgA.id, "fail")),
    ).rejects.toSatisfy((error: unknown) => {
      const parts: string[] = []
      let current: unknown = error
      for (let i = 0; i < 6 && current; i++) {
        if (current instanceof Error) {
          parts.push(current.message)
          if ("code" in current) parts.push(String(current.code))
          current = current.cause
          continue
        }
        parts.push(String(current))
        break
      }
      return /row-level security|42501|violates.*policy/i.test(parts.join("\n"))
    })

    expect(() => getOrgDb()).toThrow(/Org database not initialized/)
  })
})

describe("workspace DELETE statuses", () => {
  it("returns 404 across orgs, 400 on confirm mismatch, 204 on delete", async () => {
    const ws = workspaceValues(orgA.id, "del")
    await withOrgDbContext(orgA.id, async (db) => {
      await db.insert(workspaces).values(ws)
    })

    await expect(
      deleteWorkspaceHttpStatus(orgB, ws.slug, ws.displayName),
    ).resolves.toBe(404)
    await expect(
      deleteWorkspaceHttpStatus(orgA, ws.slug, "wrong name"),
    ).resolves.toBe(400)
    await expect(
      deleteWorkspaceHttpStatus(orgA, ws.slug, ws.displayName),
    ).resolves.toBe(204)
    await expect(
      deleteWorkspaceHttpStatus(orgA, ws.slug, ws.displayName),
    ).resolves.toBe(404)

    const gone = await withOrgDbContext(orgA.id, async (db) =>
      db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, ws.id)),
    )
    expect(gone).toEqual([])
  })
})

describe("withOrgDbContext GUC", () => {
  it("still uses set_config(..., true)", async () => {
    let sawLocal = false
    await withOrgDbContext(orgA.id, async (db) => {
      const result = await db.execute(
        sql`select current_setting('app.organization_id', true) as v`,
      )
      const rows =
        (result as { rows?: Array<{ v?: string }> }).rows ??
        (Array.isArray(result) ? result : [])
      expect((rows[0] as { v?: string } | undefined)?.v).toBe(orgA.id)
      sawLocal = true
    })
    expect(sawLocal).toBe(true)
  })
})
