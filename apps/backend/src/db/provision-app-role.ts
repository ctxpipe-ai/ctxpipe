import type { Pool } from "pg"
import { log } from "../observability/logger.js"

export const APP_ROLE_NAME = "ctxpipe_app"

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/

function quoteIdent(name: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(`refusing unsafe SQL identifier: ${name}`)
  }
  return `"${name}"`
}

function isUserSchema(nspname: string): boolean {
  return nspname !== "information_schema" && !nspname.startsWith("pg_")
}

/**
 * Create `ctxpipe_app` (LOGIN, no BYPASSRLS) and grant DML on existing and
 * future objects. Runs as the table owner before and after drizzle migrate.
 * Password is bound as a parameter — never interpolated into SQL.
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
    }
    await client.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD $1`, [password])

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
      .filter(isUserSchema)

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
