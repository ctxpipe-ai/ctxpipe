import type { Pool, PoolClient } from "pg"

import { log } from "../observability/logger.js"
import { quoteIdent } from "./provision-app-role.js"

/** The database role of the operator console. */
export const CONSOLE_ROLE_NAME = "ctxpipe_console"

/*
 * The column lists are the contract with the console. Never add a secret: a
 * session token, a password hash, an API key hash, an OAuth token or secret,
 * or a two-factor secret. A view runs with the rights of its owner (the
 * migrate role), so the console role needs no right on the tables.
 * `CREATE OR REPLACE VIEW` can only add columns at the end: to remove or
 * rename one, drop the view first.
 */
const READ_VIEWS: Record<string, string> = {
  users: `SELECT id, name, email, email_verified, banned, ban_reason, ban_expires, created_at FROM public.users`,
  organizations: `SELECT id, name, slug, created_at FROM public.organizations`,
  members: `SELECT id, organization_id, user_id, role, created_at FROM public.members`,
  invitations: `SELECT id, organization_id, email, role, status, expires_at, inviter_id, created_at FROM public.invitations`,
  sessions: `SELECT id, user_id, active_organization_id, ip_address, user_agent, created_at, expires_at FROM public.sessions`,
}

/** Only these jobs, which the worker runs (openworkflow/workflows/admin.ts). */
const ADMIN_RUN = `"workflow_name" LIKE 'admin.%'`

/**
 * Whether the migrate role has a direct membership in the console role that
 * gives its rights or SET ROLE. The ADMIN OPTION that the creator of a role
 * gets (PostgreSQL 16) gives neither, and stays.
 */
async function holdsConsoleRole(client: PoolClient): Promise<boolean> {
  const held = await client.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_catalog.pg_auth_members m
       JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
       JOIN pg_catalog.pg_roles mbr ON mbr.oid = m.member
       WHERE r.rolname = $1 AND mbr.rolname = current_user
         AND (m.inherit_option OR m.set_option)
     ) AS held`,
    [CONSOLE_ROLE_NAME],
  )
  return held.rows[0]?.held ?? false
}

async function dropConsoleMembership(client: PoolClient): Promise<void> {
  if (await holdsConsoleRole(client))
    await client.query(
      `REVOKE ${quoteIdent(CONSOLE_ROLE_NAME)} FROM CURRENT_USER`,
    )
}

/**
 * Give the operator console its own access to the database:
 * - the role `ctxpipe_console` (LOGIN, no password; `rds_iam` where that role
 *   exists, for IAM database authentication on RDS),
 * - the schema `console` for its own state, owned by it,
 * - read views of the auth tables in the schema `console_read`,
 * - INSERT and SELECT on `openworkflow.workflow_runs`, limited by row-level
 *   security to the `admin.*` jobs. Every other role keeps every row. The
 *   table owner (migrate) is not subject to the policy.
 *
 * Runs as the table owner, after the OpenWorkflow migrations. Each step is
 * idempotent, and the migrate role ends with no membership in the console
 * role. A migrate role that may not create roles skips this with a warning,
 * so a self-hosted database without a console still migrates.
 */
export async function provisionConsoleRole(pool: Pool): Promise<void> {
  const role = quoteIdent(CONSOLE_ROLE_NAME)
  const client = await pool.connect()
  try {
    const roles = await client.query<{ rolname: string; elevated: boolean }>(
      "SELECT rolname, rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb AS elevated FROM pg_catalog.pg_roles WHERE rolname IN ($1, 'rds_iam')",
      [CONSOLE_ROLE_NAME],
    )
    const has = (name: string) => roles.rows.some((r) => r.rolname === name)
    if (roles.rows.some((r) => r.rolname === CONSOLE_ROLE_NAME && r.elevated))
      throw new Error(
        `role ${CONSOLE_ROLE_NAME} has elevated attributes; refusing to continue`,
      )
    // A role that something else made can hold the rights of another role.
    const groups = await client.query<{ rolname: string }>(
      `SELECT r.rolname FROM pg_catalog.pg_auth_members m
       JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
       JOIN pg_catalog.pg_roles mbr ON mbr.oid = m.member
       WHERE mbr.rolname = $1 AND r.rolname <> 'rds_iam'`,
      [CONSOLE_ROLE_NAME],
    )
    if (groups.rows.length > 0)
      throw new Error(
        `role ${CONSOLE_ROLE_NAME} is a member of ${groups.rows.map((r) => r.rolname).join(", ")}; refusing to continue`,
      )
    if (!has(CONSOLE_ROLE_NAME)) {
      const me = await client.query<{ allowed: boolean }>(
        "SELECT rolsuper OR rolcreaterole AS allowed FROM pg_catalog.pg_roles WHERE rolname = current_user",
      )
      if (!me.rows[0]?.allowed) {
        log.warn({
          step: "migrate",
          message:
            "[migrate] the migrate role may not create roles: no console role",
          role: CONSOLE_ROLE_NAME,
        })
        return
      }
    }

    await client.query("BEGIN")
    if (!has(CONSOLE_ROLE_NAME))
      await client.query(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      )
    if (has("rds_iam")) await client.query(`GRANT rds_iam TO ${role}`)
    const database = (
      await client.query<{ name: string }>("SELECT current_database() AS name")
    ).rows[0]?.name
    if (!database) throw new Error("current_database() returned empty")
    await client.query(
      `GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${role}`,
    )

    // To make the console role the owner of a schema, and to change the
    // rights on that schema, a role must be able to SET ROLE to it. A creator
    // that is not a superuser (the RDS master user) gets only ADMIN OPTION.
    // Thus the migrate role gets the membership in this transaction only. It
    // must not keep it: on RDS the console role is a member of `rds_iam`,
    // and a member of `rds_iam` cannot log in with a password. This also
    // removes a membership that an earlier migrate left.
    const canSet = await client.query<{ ok: boolean }>(
      "SELECT pg_has_role(current_user, $1, 'SET') AS ok",
      [CONSOLE_ROLE_NAME],
    )
    if (!canSet.rows[0]?.ok) await client.query(`GRANT ${role} TO CURRENT_USER`)
    await client.query(
      `CREATE SCHEMA IF NOT EXISTS console AUTHORIZATION ${role}`,
    )
    await client.query(`ALTER SCHEMA console OWNER TO ${role}`)
    await client.query("REVOKE ALL ON SCHEMA console FROM PUBLIC")
    await dropConsoleMembership(client)

    await client.query("CREATE SCHEMA IF NOT EXISTS console_read")
    await client.query("REVOKE ALL ON SCHEMA console_read FROM PUBLIC")
    await client.query(`GRANT USAGE ON SCHEMA console_read TO ${role}`)
    for (const [name, query] of Object.entries(READ_VIEWS)) {
      const view = `console_read.${quoteIdent(name)}`
      await client.query(`CREATE OR REPLACE VIEW ${view} AS ${query}`)
      await client.query(`REVOKE ALL ON ${view} FROM PUBLIC`)
      await client.query(`GRANT SELECT ON ${view} TO ${role}`)
    }

    // OpenWorkflow's enqueue: an advisory lock, a SELECT by idempotency key,
    // and `INSERT ... RETURNING *`. A poll for the result reads the run.
    await client.query(`GRANT USAGE ON SCHEMA openworkflow TO ${role}`)
    await client.query(
      `GRANT SELECT, INSERT ON openworkflow.workflow_runs TO ${role}`,
    )
    // One policy for every role, so that it names no role: a dump and
    // restore of the database (`copy-database.ts`) needs no role. Every role
    // but the console keeps every row. The console reads only admin runs,
    // and inserts only a new one: no worker, no parent, no attempt yet. A
    // statement on the table takes a lock that stops the worker, so it runs
    // only when the policy is missing.
    const existing = await client.query(
      "SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'openworkflow' AND tablename = 'workflow_runs' AND policyname = 'console_admin_runs_only'",
    )
    const notConsole = `current_user <> '${CONSOLE_ROLE_NAME}'`
    if (existing.rowCount === 0)
      await client.query(
        `CREATE POLICY console_admin_runs_only ON openworkflow.workflow_runs
         AS PERMISSIVE FOR ALL TO PUBLIC
         USING (${notConsole} OR ${ADMIN_RUN})
         WITH CHECK (${notConsole} OR (${ADMIN_RUN} AND "status" = 'pending' AND "attempts" = 0 AND "worker_id" IS NULL AND "parent_step_attempt_id" IS NULL))`,
      )
    const rls = await client.query<{ on: boolean }>(
      "SELECT relrowsecurity AS on FROM pg_catalog.pg_class WHERE oid = 'openworkflow.workflow_runs'::regclass",
    )
    if (!rls.rows[0]?.on)
      await client.query(
        "ALTER TABLE openworkflow.workflow_runs ENABLE ROW LEVEL SECURITY",
      )
    // REVOKE only warns when another role granted the membership.
    if (await holdsConsoleRole(client))
      throw new Error(
        `the migrate role is still a member of ${CONSOLE_ROLE_NAME}; refusing to continue`,
      )
    await client.query("COMMIT")
    log.info({
      step: "migrate",
      message: "[migrate] provisioned console role",
      role: CONSOLE_ROLE_NAME,
    })
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
