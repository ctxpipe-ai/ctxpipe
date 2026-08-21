import type { Pool, PoolClient } from "pg"
import { log } from "../observability/logger.js"

export const APP_ROLE_NAME = "ctxpipe_app"

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/
const APP_SCHEMAS = new Set(["public", "openworkflow"])

function quoteIdent(name: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(`refusing unsafe SQL identifier: ${name}`)
  }
  return `"${name}"`
}

function isAppSchema(nspname: string): boolean {
  return APP_SCHEMAS.has(nspname)
}

async function alterRolePassword(
  client: PoolClient,
  roleName: string,
  password: string,
): Promise<void> {
  const formatted = await client.query<{ sql: string }>(
    "SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS sql",
    [roleName, password],
  )
  const sql = formatted.rows[0]?.sql
  if (!sql) {
    throw new Error("format() returned empty ALTER ROLE")
  }
  await client.query(sql)
}

async function assertAppRoleSafe(
  client: PoolClient,
  roleName: string,
): Promise<void> {
  const attrs = await client.query<{
    rolsuper: boolean
    rolbypassrls: boolean
    rolcreatedb: boolean
    rolcreaterole: boolean
    rolreplication: boolean
    rolcanlogin: boolean
  }>(
    `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
     FROM pg_catalog.pg_roles
     WHERE rolname = $1`,
    [roleName],
  )
  const role = attrs.rows[0]
  if (!role) {
    throw new Error(`app role ${roleName} missing after CREATE ROLE`)
  }
  if (
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication
  ) {
    throw new Error(
      `app role ${roleName} has elevated attributes (bypassrls=${role.rolbypassrls} super=${role.rolsuper}); refusing to continue`,
    )
  }
  if (!role.rolcanlogin) {
    throw new Error(`app role ${roleName} cannot LOGIN`)
  }

  const ownedRelation = await client.query<{ n: string }>(
    `SELECT c.relname AS n
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
     WHERE r.rolname = $1
     LIMIT 1`,
    [roleName],
  )
  if (ownedRelation.rows.length > 0) {
    throw new Error(
      `app role ${roleName} owns relation ${ownedRelation.rows[0]?.n}; runtime role must own nothing`,
    )
  }

  const ownedSchema = await client.query<{ n: string }>(
    `SELECT n.nspname AS n
     FROM pg_catalog.pg_namespace n
     JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
     WHERE r.rolname = $1
     LIMIT 1`,
    [roleName],
  )
  if (ownedSchema.rows.length > 0) {
    throw new Error(
      `app role ${roleName} owns schema ${ownedSchema.rows[0]?.n}; runtime role must own nothing`,
    )
  }

  const ownedDatabase = await client.query<{ n: string }>(
    `SELECT d.datname AS n
     FROM pg_catalog.pg_database d
     JOIN pg_catalog.pg_roles r ON r.oid = d.datdba
     WHERE r.rolname = $1
     LIMIT 1`,
    [roleName],
  )
  if (ownedDatabase.rows.length > 0) {
    throw new Error(
      `app role ${roleName} owns database ${ownedDatabase.rows[0]?.n}; runtime role must own nothing`,
    )
  }

  const ownedFunction = await client.query<{ n: string }>(
    `SELECT p.proname AS n
     FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
     WHERE r.rolname = $1
     LIMIT 1`,
    [roleName],
  )
  if (ownedFunction.rows.length > 0) {
    throw new Error(
      `app role ${roleName} owns function ${ownedFunction.rows[0]?.n}; runtime role must own nothing`,
    )
  }

  const membership = await client.query<{ n: string }>(
    `SELECT r.rolname AS n
     FROM pg_catalog.pg_auth_members m
     JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
     JOIN pg_catalog.pg_roles mbr ON mbr.oid = m.member
     WHERE mbr.rolname = $1
     LIMIT 1`,
    [roleName],
  )
  if (membership.rows.length > 0) {
    throw new Error(
      `app role ${roleName} is a member of ${membership.rows[0]?.n}; runtime role must not SET ROLE`,
    )
  }
}

/**
 * Create `ctxpipe_app` (LOGIN, no BYPASSRLS) and grant DML on application
 * schemas. Runs as the table owner before and after drizzle migrate.
 * Password is quoted by Postgres `format(%L)`, never interpolated in JS.
 */
export async function provisionAppRole(
  pool: Pool,
  password: string,
  roleName: string = APP_ROLE_NAME,
): Promise<void> {
  const role = quoteIdent(roleName)
  const client = await pool.connect()
  try {
    const existing = await client.query(
      "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1",
      [roleName],
    )
    if ((existing.rowCount ?? 0) === 0) {
      await client.query(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      )
    } else {
      await assertAppRoleSafe(client, roleName)
    }
    await alterRolePassword(client, roleName, password)
    await assertAppRoleSafe(client, roleName)

    const databaseName = (
      await client.query<{ current_database: string }>(
        "SELECT current_database()",
      )
    ).rows[0]?.current_database
    if (!databaseName) {
      throw new Error("current_database() returned empty")
    }
    await client.query(
      `GRANT CONNECT ON DATABASE ${quoteIdent(databaseName)} TO ${role}`,
    )

    const schemas = (
      await client.query<{ nspname: string }>(
        "SELECT nspname FROM pg_catalog.pg_namespace",
      )
    ).rows
      .map((row) => row.nspname)
      .filter(isAppSchema)

    for (const schemaName of schemas) {
      const schema = quoteIdent(schemaName)
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`)
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
      )
      await client.query(
        `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`,
      )
      await client.query(
        `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role}`,
      )
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
      )
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
      )
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO ${role}`,
      )
    }

    log.info({
      step: "migrate",
      message: "[migrate] provisioned app role",
      role: roleName,
      schemaCount: schemas.length,
    })
  } finally {
    client.release()
  }
}
