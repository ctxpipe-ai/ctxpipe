import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"
import { provisionAppRole } from "./provision-app-role.js"
import { runMigrations } from "./run-migrations.js"

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const database = `ctxpipe_test_run_migrations_${suffix}`
// A role of this run only, so that the shared ctxpipe_app is not changed.
const roleName = `ctxpipe_app_test_${suffix}`
const password = "role-password-1"
// A role as the Neon API makes it: a member of a group with BYPASSRLS.
const apiRoleName = `ctxpipe_app_api_${suffix}`
const apiGroupName = `neon_superuser_test_${suffix}`

let admin: pg.Client
let pool: pg.Pool
let databaseUrl: string

async function tableExists(name: string): Promise<boolean> {
  const result = await pool.query<{ found: string | null }>(
    "SELECT to_regclass($1) AS found",
    [name],
  )
  return result.rows[0]?.found !== null
}

async function appliedMigrations(): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM "drizzle"."__drizzle_migrations"`,
  )
  return Number(result.rows[0]?.n)
}

/** Connect as the test role with its password and read one table. */
async function readAsRole(): Promise<void> {
  const url = new URL(databaseUrl)
  url.username = roleName
  url.password = password
  const client = new pg.Client({ connectionString: url.toString() })
  await client.connect()
  try {
    await client.query(`SELECT count(*) FROM "organizations"`)
  } finally {
    await client.end()
  }
}

describe("runMigrations", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    const ownerUrl = new URL(ownerUrlForMigrate(process.env.DATABASE_URL))
    admin = new pg.Client({ connectionString: ownerUrl.toString() })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${database}"`)
    ownerUrl.pathname = `/${database}`
    databaseUrl = ownerUrl.toString()
    pool = new pg.Pool({ connectionString: databaseUrl })
    // DROP DATABASE ... WITH (FORCE) in afterAll can end a socket that
    // pool.end() has not closed yet. The pool re-emits that FATAL 57P01 as a
    // pool "error" event, which throws when nothing listens.
    pool.on("error", (error) => console.warn("Pool error at teardown", error))
  })

  afterAll(async () => {
    await pool?.end()
    await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    await admin?.query(`DROP ROLE IF EXISTS "${roleName}"`)
    await admin?.query(`DROP ROLE IF EXISTS "${apiRoleName}"`)
    await admin?.query(`DROP ROLE IF EXISTS "${apiGroupName}"`)
    await admin?.end()
  })

  it("stops before any change when the role is missing and no password is given", async () => {
    await expect(
      runMigrations({
        connectionString: databaseUrl,
        appRolePassword: undefined,
        roleName,
      }),
    ).rejects.toThrow(
      /does not exist and DATABASE_APP_PASSWORD is not set[\s\S]*Docker Compose[\s\S]*AWS CDK[\s\S]*terraform apply -target=module\.ctxpipe\.random_password\.app_database/,
    )
    expect(await tableExists("public.organizations")).toBe(false)
    expect(await tableExists("drizzle.__drizzle_migrations")).toBe(false)
  })

  it("creates the role from the password, then migrates and grants", async () => {
    await runMigrations({
      connectionString: databaseUrl,
      appRolePassword: password,
      roleName,
    })
    expect(await tableExists("public.organizations")).toBe(true)
    expect(await tableExists("openworkflow.workflow_runs")).toBe(true)
    await readAsRole()
  })

  it("with no password and an existing role, keeps the password and runs every backfill", async () => {
    const migrationsBefore = await appliedMigrations()
    await pool.query(
      `INSERT INTO "organizations" ("id", "name", "slug", "created_at") VALUES ('org_run_migrations', 'Acme', 'acme-run-migrations', now())`,
    )
    await pool.query(
      `INSERT INTO "repositories" ("id", "org_id", "name", "git_url") VALUES ('repo_run_migrations', 'org_run_migrations', 'kept', 'https://github.com/acme/kept')`,
    )
    // A row with no org_id that the trigger did not fill, as after a rollback.
    const owner = await pool.connect()
    try {
      await owner.query("SET session_replication_role = replica")
      await owner.query(
        `INSERT INTO "repository_checkouts" ("id", "repository_id", "checkout_key") VALUES ('checkout_null_org', 'repo_run_migrations', 'main')`,
      )
    } finally {
      await owner.query("SET session_replication_role = origin")
      owner.release()
    }

    await runMigrations({
      connectionString: databaseUrl,
      appRolePassword: undefined,
      roleName,
    })

    expect(await appliedMigrations()).toBe(migrationsBefore)
    const checkout = await pool.query<{ org_id: string | null }>(
      `SELECT "org_id" FROM "repository_checkouts" WHERE "id" = 'checkout_null_org'`,
    )
    expect(checkout.rows[0]?.org_id).toBe("org_run_migrations")
    await readAsRole()
  })

  it("with a password, takes back the group and the rights of a role that the Neon API made", async () => {
    await admin.query(`CREATE ROLE "${apiGroupName}" NOLOGIN BYPASSRLS`)
    await admin.query(
      `CREATE ROLE "${apiRoleName}" LOGIN CREATEDB CREATEROLE IN ROLE "${apiGroupName}"`,
    )
    await expect(
      provisionAppRole(pool, undefined, apiRoleName),
    ).rejects.toThrow(/elevated attributes|is a member of/)

    await provisionAppRole(pool, password, apiRoleName)

    const role = await pool.query(
      `SELECT r.rolcreatedb, r.rolcreaterole, r.rolbypassrls,
              (SELECT count(*)::int FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS groups
       FROM pg_catalog.pg_roles r WHERE r.rolname = $1`,
      [apiRoleName],
    )
    expect(role.rows[0]).toEqual({
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
      groups: 0,
    })
  })

  it("fails with a clear message when a lock holds a migration statement", async () => {
    const lockDatabase = `${database}_lock`
    const lockRole = `${roleName}_lock`
    await admin.query(`CREATE DATABASE "${lockDatabase}"`)
    const lockUrl = new URL(databaseUrl)
    lockUrl.pathname = `/${lockDatabase}`
    const holder = new pg.Client({ connectionString: lockUrl.toString() })
    await holder.connect()
    try {
      // Drizzle reads this table first, so a lock on it stops the run at once.
      await holder.query(`CREATE SCHEMA "drizzle"`)
      await holder.query(
        `CREATE TABLE "drizzle"."__drizzle_migrations" (id serial primary key, hash text not null, created_at bigint)`,
      )
      await holder.query("BEGIN")
      await holder.query(
        `LOCK TABLE "drizzle"."__drizzle_migrations" IN ACCESS EXCLUSIVE MODE`,
      )
      await expect(
        runMigrations({
          connectionString: lockUrl.toString(),
          appRolePassword: password,
          roleName: lockRole,
          lockTimeoutMs: 500,
        }),
      ).rejects.toThrow(/waited more than 500 ms for a database lock/)
    } finally {
      await holder.end()
      await admin.query(
        `DROP DATABASE IF EXISTS "${lockDatabase}" WITH (FORCE)`,
      )
      await admin.query(`DROP ROLE IF EXISTS "${lockRole}"`)
    }
  })
})
