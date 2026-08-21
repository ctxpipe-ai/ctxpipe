import { Pool } from "pg"
import { log } from "../observability/logger.js"

export type RuntimeRoleRow = {
  rolname: string
  rolbypassrls: boolean | string
}

function roleHasBypassRls(value: boolean | string): boolean {
  if (typeof value === "string") {
    return value === "t" || value === "true"
  }
  return value === true
}

export function assertRuntimeRoleDoesNotBypassRlsFromRow(
  row: RuntimeRoleRow | undefined,
): void {
  if (!row) {
    throw new Error(
      "Could not resolve current_user in pg_roles; refusing to boot",
    )
  }
  if (roleHasBypassRls(row.rolbypassrls)) {
    throw new Error(
      `Database role ${row.rolname} has BYPASSRLS; runtime DATABASE_URL must use ctxpipe_app (not the owner/migrate URL)`,
    )
  }
}

export async function assertRuntimeRoleDoesNotBypassRls(
  connectionString: string,
): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const result = await pool.query<RuntimeRoleRow>(
      `SELECT rolname, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user`,
    )
    assertRuntimeRoleDoesNotBypassRlsFromRow(result.rows[0])
    log.info({
      step: "boot.runtime-role",
      message: "Runtime database role does not bypass RLS",
      rolname: result.rows[0]?.rolname,
    })
  } finally {
    await pool.end()
  }
}
