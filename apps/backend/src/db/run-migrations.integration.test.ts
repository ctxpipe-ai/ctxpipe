import pg from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { log } from "../observability/logger.js"
import { describeMigrateError } from "./describe-migrate-error.js"
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

  /** A fresh database and a role of its own, so that each run starts from nothing. */
  async function withFreshDatabase(
    name: string,
    run: (url: string, lockRole: string) => Promise<void>,
  ): Promise<void> {
    const freshDatabase = `${database}_${name}`
    const freshRole = `${roleName}_${name}`
    await admin.query(`CREATE DATABASE "${freshDatabase}"`)
    const url = new URL(databaseUrl)
    url.pathname = `/${freshDatabase}`
    try {
      await run(url.toString(), freshRole)
    } finally {
      await admin.query(
        `DROP DATABASE IF EXISTS "${freshDatabase}" WITH (FORCE)`,
      )
      await admin.query(`DROP ROLE IF EXISTS "${freshRole}"`)
    }
  }

  /** Hold ACCESS EXCLUSIVE on the table Drizzle reads first, in an open transaction. */
  async function holdDrizzleLock(url: string): Promise<pg.Client> {
    const holder = new pg.Client({ connectionString: url })
    await holder.connect()
    await holder.query(`CREATE SCHEMA "drizzle"`)
    await holder.query(
      `CREATE TABLE "drizzle"."__drizzle_migrations" (id serial primary key, hash text not null, created_at bigint)`,
    )
    await holder.query("BEGIN")
    await holder.query(
      `LOCK TABLE "drizzle"."__drizzle_migrations" IN ACCESS EXCLUSIVE MODE`,
    )
    return holder
  }

  it("fails with a clear message and the Postgres cause when a lock holds the migration on every try", async () => {
    await withFreshDatabase("lock", async (url, lockRole) => {
      const holder = await holdDrizzleLock(url)
      try {
        const error = await runMigrations({
          connectionString: url,
          appRolePassword: password,
          roleName: lockRole,
          drizzleLockRetry: {
            lockTimeoutMs: 200,
            tries: 2,
            baseDelayMs: 50,
            maxDelayMs: 50,
          },
        }).catch((caught: unknown) => caught)
        expect((error as Error).message).toMatch(
          /waited more than 200 ms for a database lock on each of 2 tries[\s\S]*End that session/,
        )
        expect(describeMigrateError(error)).toMatch(
          /Caused by: [\s\S]*SQLSTATE 55P03/,
        )
      } finally {
        await holder.end()
      }
    })
  })

  it("retries the migration on a lock timeout and succeeds when the lock goes away", async () => {
    const warn = vi.spyOn(log, "warn")
    await withFreshDatabase("retry", async (url, lockRole) => {
      const holder = await holdDrizzleLock(url)
      // Longer than two lock timeouts, so that at least two tries roll back.
      setTimeout(() => void holder.end(), 1_000)
      const started = Date.now()
      try {
        await runMigrations({
          connectionString: url,
          appRolePassword: password,
          roleName: lockRole,
          drizzleLockRetry: {
            lockTimeoutMs: 200,
            tries: 10,
            baseDelayMs: 100,
            maxDelayMs: 200,
          },
        })
      } finally {
        await holder.end().catch(() => {})
      }
      expect(Date.now() - started).toBeGreaterThanOrEqual(900)
      const retries = warn.mock.calls.filter(
        ([event]) =>
          (event as { step?: string }).step === "migrate" &&
          (event as { attempt?: number }).attempt !== undefined,
      )
      expect(retries.length).toBeGreaterThanOrEqual(2)
      expect(retries[0]?.[0]).toMatchObject({ attempt: 1, waitMs: 100 })
      expect(retries[1]?.[0]).toMatchObject({ attempt: 2, waitMs: 200 })
      const check = new pg.Client({ connectionString: url })
      await check.connect()
      try {
        const found = await check.query(
          `SELECT to_regclass('public.organizations') AS found`,
        )
        expect(found.rows[0]?.found).not.toBeNull()
      } finally {
        await check.end()
      }
    })
    warn.mockRestore()
  })

  it("does not retry an error that is not a lock timeout, and names the cause", async () => {
    const warn = vi.spyOn(log, "warn")
    await withFreshDatabase("nolock", async (url, lockRole) => {
      const setup = new pg.Client({ connectionString: url })
      await setup.connect()
      try {
        // A migrations table without the columns Drizzle reads: error 42703.
        await setup.query(`CREATE SCHEMA "drizzle"`)
        await setup.query(
          `CREATE TABLE "drizzle"."__drizzle_migrations" (id serial primary key)`,
        )
      } finally {
        await setup.end()
      }
      const started = Date.now()
      const error = await runMigrations({
        connectionString: url,
        appRolePassword: password,
        roleName: lockRole,
        drizzleLockRetry: {
          lockTimeoutMs: 200,
          tries: 10,
          baseDelayMs: 60_000,
          maxDelayMs: 60_000,
        },
      }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(Error)
      expect(Date.now() - started).toBeLessThan(30_000)
      expect(describeMigrateError(error)).toMatch(/SQLSTATE 42703/)
      expect(
        warn.mock.calls.filter(
          ([event]) => (event as { attempt?: number }).attempt !== undefined,
        ),
      ).toHaveLength(0)
    })
    warn.mockRestore()
  })
})
