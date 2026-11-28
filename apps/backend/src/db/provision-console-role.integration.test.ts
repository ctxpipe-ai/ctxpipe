import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ownerUrlForMigrate } from "./owner-migrate-url.js"
import {
  CONSOLE_ROLE_NAME,
  provisionConsoleRole,
} from "./provision-console-role.js"

/*
 * The migrate role of RDS: the master user is not a superuser. It made the
 * console role, so it has only ADMIN OPTION on it, and it has ADMIN OPTION
 * on `rds_iam` (here a plain role). A membership of the migrate role in the
 * console role makes it a member of `rds_iam`, and RDS then refuses its
 * password (CTX-1749).
 */
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const database = `ctxpipe_test_console_role_${suffix}`
const migrateRole = `ctxpipe_migrate_test_${suffix}`
const password = "migrate-password-1"
const console_ = `"${CONSOLE_ROLE_NAME}"`

let admin: pg.Client
let pool: pg.Pool
let madeIam = false

/** The migrate role's rights in a role: through a membership, or SET ROLE. */
async function membership(role: string) {
  const result = await pool.query<{ usage: boolean; set: boolean }>(
    "SELECT pg_has_role(current_user, $1, 'USAGE') AS usage, pg_has_role(current_user, $1, 'SET') AS set",
    [role],
  )
  return result.rows[0]
}

/** What the step makes, apart from the migrate role's memberships. */
async function provisioned() {
  const result = await pool.query(
    `SELECT
       (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'console') AS console_owner,
       (SELECT nspacl::text FROM pg_namespace WHERE nspname = 'console') AS console_acl,
       (SELECT array_agg(table_name::text ORDER BY table_name) FROM information_schema.views WHERE table_schema = 'console_read') AS views,
       has_table_privilege($1, 'console_read.users', 'SELECT') AS reads_users,
       has_table_privilege($1, 'openworkflow.workflow_runs', 'INSERT') AS inserts_runs,
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'openworkflow.workflow_runs'::regclass) AS rls,
       (SELECT count(*)::int FROM pg_policies WHERE policyname = 'console_admin_runs_only') AS policies,
       pg_has_role($1, 'rds_iam', 'MEMBER') AS console_iam`,
    [CONSOLE_ROLE_NAME],
  )
  return result.rows[0]
}

describe("provisionConsoleRole as a migrate role that is not a superuser", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    const ownerUrl = new URL(ownerUrlForMigrate(process.env.DATABASE_URL))
    admin = new pg.Client({ connectionString: ownerUrl.toString() })
    await admin.connect()
    madeIam =
      (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam'"))
        .rowCount === 0
    if (madeIam) await admin.query("CREATE ROLE rds_iam")
    await admin.query(
      `CREATE ROLE "${migrateRole}" LOGIN CREATEROLE PASSWORD '${password}'`,
    )
    await admin.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${CONSOLE_ROLE_NAME}') THEN
           CREATE ROLE ${console_} LOGIN;
         END IF;
       END $$`,
    )
    for (const role of [console_, "rds_iam"])
      await admin.query(
        `GRANT ${role} TO "${migrateRole}" WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
      )
    await admin.query(`CREATE DATABASE "${database}" OWNER "${migrateRole}"`)

    const url = new URL(ownerUrl)
    url.pathname = `/${database}`
    url.username = migrateRole
    url.password = password
    pool = new pg.Pool({ connectionString: url.toString() })
    pool.on("error", (error) => console.warn("Pool error at teardown", error))
    await pool.query(`
      CREATE TABLE public.users (id text, name text, email text, email_verified boolean, banned boolean, ban_reason text, ban_expires timestamptz, created_at timestamptz);
      CREATE TABLE public.organizations (id text, name text, slug text, created_at timestamptz);
      CREATE TABLE public.members (id text, organization_id text, user_id text, role text, created_at timestamptz);
      CREATE TABLE public.invitations (id text, organization_id text, email text, role text, status text, expires_at timestamptz, inviter_id text, created_at timestamptz);
      CREATE TABLE public.sessions (id text, user_id text, active_organization_id text, ip_address text, user_agent text, created_at timestamptz, expires_at timestamptz);
      CREATE SCHEMA openworkflow;
      CREATE TABLE openworkflow.workflow_runs (id text, workflow_name text, status text, attempts int, worker_id text, parent_step_attempt_id text);
    `)
  })

  afterAll(async () => {
    await pool?.end()
    await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    // The migrate role granted rds_iam to the console role.
    await admin?.query(
      `REVOKE rds_iam FROM ${console_} GRANTED BY "${migrateRole}"`,
    )
    await admin?.query(`DROP ROLE IF EXISTS "${migrateRole}"`)
    if (madeIam) await admin?.query("DROP ROLE IF EXISTS rds_iam")
    await admin?.end()
  })

  it("makes the console schema, views, grants and policy, and leaves no membership", async () => {
    await provisionConsoleRole(pool)
    expect(await membership(CONSOLE_ROLE_NAME)).toEqual({
      usage: false,
      set: false,
    })
    expect(await membership("rds_iam")).toEqual({ usage: false, set: false })
    expect(await provisioned()).toEqual({
      console_owner: CONSOLE_ROLE_NAME,
      console_acl: `{${CONSOLE_ROLE_NAME}=UC/${CONSOLE_ROLE_NAME}}`,
      views: ["invitations", "members", "organizations", "sessions", "users"],
      reads_users: true,
      inserts_runs: true,
      rls: true,
      policies: 1,
      console_iam: true,
    })
  })

  it("leaves no membership on a second run, and changes nothing", async () => {
    const before = await provisioned()
    await provisionConsoleRole(pool)
    expect(await membership(CONSOLE_ROLE_NAME)).toEqual({
      usage: false,
      set: false,
    })
    expect(await provisioned()).toEqual(before)
  })

  it("removes the membership that an earlier migrate left", async () => {
    const before = await provisioned()
    await pool.query(`GRANT ${console_} TO CURRENT_USER`)
    expect(await membership("rds_iam")).toEqual({ usage: true, set: true })
    await provisionConsoleRole(pool)
    expect(await membership(CONSOLE_ROLE_NAME)).toEqual({
      usage: false,
      set: false,
    })
    expect(await membership("rds_iam")).toEqual({ usage: false, set: false })
    expect(await provisioned()).toEqual(before)
  })

  it("makes the console schema again with no membership left", async () => {
    // The superuser drops it: the migrate role is not its owner.
    const ownerUrl = new URL(ownerUrlForMigrate(process.env.DATABASE_URL ?? ""))
    ownerUrl.pathname = `/${database}`
    const owner = new pg.Client({ connectionString: ownerUrl.toString() })
    await owner.connect()
    try {
      await owner.query("DROP SCHEMA console")
    } finally {
      await owner.end()
    }
    await provisionConsoleRole(pool)
    expect(await membership(CONSOLE_ROLE_NAME)).toEqual({
      usage: false,
      set: false,
    })
    expect((await provisioned())?.console_owner).toBe(CONSOLE_ROLE_NAME)
  })
})
