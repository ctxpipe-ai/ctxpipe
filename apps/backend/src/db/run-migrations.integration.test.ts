import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"
import { runMigrations } from "./run-migrations.js"

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const database = `ctxpipe_test_run_migrations_${suffix}`
// A role of this run only, so that the shared ctxpipe_app is not changed.
const roleName = `ctxpipe_app_test_${suffix}`
const password = "role-password-1"

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
  })

  afterAll(async () => {
    await pool?.end()
    await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    await admin?.query(`DROP ROLE IF EXISTS "${roleName}"`)
    await admin?.end()
  })

  it("stops before any change when the role is missing and no password is given", async () => {
    await expect(
      runMigrations({
        connectionString: databaseUrl,
        appRolePassword: undefined,
        env: {},
        roleName,
      }),
    ).rejects.toThrow(
      /does not exist and DATABASE_APP_PASSWORD is not set[\s\S]*Docker Compose[\s\S]*AWS CDK[\s\S]*terraform apply -target=module\.ctxpipe\.neon_role\.app/,
    )
    expect(await tableExists("public.organizations")).toBe(false)
    expect(await tableExists("drizzle.__drizzle_migrations")).toBe(false)
  })

  it("creates the role from the password, then migrates and grants", async () => {
    await runMigrations({
      connectionString: databaseUrl,
      appRolePassword: password,
      env: {},
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
      env: {},
      roleName,
    })

    expect(await appliedMigrations()).toBe(migrationsBefore)
    const checkout = await pool.query<{ org_id: string | null }>(
      `SELECT "org_id" FROM "repository_checkouts" WHERE "id" = 'checkout_null_org'`,
    )
    expect(checkout.rows[0]?.org_id).toBe("org_run_migrations")
    await readAsRole()
  })
})
