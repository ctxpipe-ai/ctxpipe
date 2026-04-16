import { describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import { initDb, withOrgDbContext, withSystemDbContext } from "./client.js"
import { repositories } from "./schema/repositories.js"

const connectionString = process.env.DATABASE_URL

describe("db RLS (orgId)", () => {
  it("isolates org-scoped tables and supports system access", async () => {
    if (!connectionString) {
      throw new Error("DATABASE_URL must be set for RLS integration test")
    }

    void initDb(connectionString)

    await withSystemDbContext(async (systemDb) => {
      // In tests we often connect as a superuser / BYPASSRLS role (e.g. `ctxpipe`).
      // To validate RLS behavior, we SET ROLE to a dedicated non-bypass role.
      await systemDb.execute(sql`
        do $$
        begin
          create role rls_test;
        exception
          when duplicate_object then null;
        end
        $$;
      `)
      await systemDb.execute(
        sql`grant all privileges on table "repositories" to rls_test`,
      )
      await systemDb.execute(sql`truncate table "repositories" restart identity cascade`)
    })

    await withOrgDbContext("org_a", async (orgDb) => {
      await orgDb.execute(sql`set local role rls_test`)
      await orgDb.execute(sql`set local row_security = on`)
      await orgDb.execute(sql`select set_config('app.system_access', 'false', true)`)
      await orgDb.insert(repositories).values({
        id: "repo_org_a",
        orgId: "org_a",
        name: "a",
        gitUrl: "https://example.com/a.git",
      })
    })

    await withOrgDbContext("org_b", async (orgDb) => {
      await orgDb.execute(sql`set local role rls_test`)
      await orgDb.execute(sql`set local row_security = on`)
      await orgDb.execute(sql`select set_config('app.system_access', 'false', true)`)
      await orgDb.insert(repositories).values({
        id: "repo_org_b",
        orgId: "org_b",
        name: "b",
        gitUrl: "https://example.com/b.git",
      })
    })

    await withOrgDbContext("org_a", async (orgDb) => {
      await orgDb.execute(sql`set local role rls_test`)
      await orgDb.execute(sql`set local row_security = on`)
      await orgDb.execute(sql`select set_config('app.system_access', 'false', true)`)
      const rows = await orgDb
        .select({ id: repositories.id })
        .from(repositories)
        .orderBy(repositories.id)
      expect(rows).toEqual([{ id: "repo_org_a" }])
    })

    await withOrgDbContext("org_b", async (orgDb) => {
      await orgDb.execute(sql`set local role rls_test`)
      await orgDb.execute(sql`set local row_security = on`)
      await orgDb.execute(sql`select set_config('app.system_access', 'false', true)`)
      const rows = await orgDb
        .select({ id: repositories.id })
        .from(repositories)
        .orderBy(repositories.id)
      expect(rows).toEqual([{ id: "repo_org_b" }])
    })

    await withOrgDbContext("org_a", async (orgDb) => {
      await orgDb.execute(sql`set local role rls_test`)
      await orgDb.execute(sql`set local row_security = on`)
      await orgDb.execute(sql`select set_config('app.system_access', 'false', true)`)
      await expect(
        orgDb.insert(repositories).values({
          id: "repo_cross",
          orgId: "org_b",
          name: "cross",
          gitUrl: "https://example.com/cross.git",
        }),
      ).rejects.toThrow()
    })

    await withSystemDbContext(async (systemDb) => {
      const rows = await systemDb
        .select({ id: repositories.id })
        .from(repositories)
        .orderBy(repositories.id)
      expect(rows).toEqual([{ id: "repo_org_a" }, { id: "repo_org_b" }])
    })
  })
})

