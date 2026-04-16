import { sql, type SQL } from "drizzle-orm"
import { pgPolicy, type AnyPgColumn } from "drizzle-orm/pg-core"

function tenantMatch(orgIdColumn: AnyPgColumn): SQL {
  return sql`(${orgIdColumn} = current_setting('app.organization_id', true))`
}

function systemAccessEnabled(): SQL {
  return sql`current_setting('app.system_access', true) = 'true'`
}

export function tenantRlsPolicies(
  tableName: string,
  orgIdColumn: AnyPgColumn,
) {
  return [
    pgPolicy(`${tableName}_system_access_select`, {
      for: "select",
      to: "public",
      using: systemAccessEnabled(),
    }),
    pgPolicy(`${tableName}_tenant_select`, {
      for: "select",
      to: "public",
      using: tenantMatch(orgIdColumn),
    }),
    pgPolicy(`${tableName}_system_access_insert`, {
      for: "insert",
      to: "public",
      withCheck: systemAccessEnabled(),
    }),
    pgPolicy(`${tableName}_tenant_insert`, {
      for: "insert",
      to: "public",
      withCheck: tenantMatch(orgIdColumn),
    }),
    pgPolicy(`${tableName}_system_access_update`, {
      for: "update",
      to: "public",
      using: systemAccessEnabled(),
      withCheck: systemAccessEnabled(),
    }),
    pgPolicy(`${tableName}_tenant_update`, {
      for: "update",
      to: "public",
      using: tenantMatch(orgIdColumn),
      withCheck: tenantMatch(orgIdColumn),
    }),
    pgPolicy(`${tableName}_system_access_delete`, {
      for: "delete",
      to: "public",
      using: systemAccessEnabled(),
    }),
    pgPolicy(`${tableName}_tenant_delete`, {
      for: "delete",
      to: "public",
      using: tenantMatch(orgIdColumn),
    }),
  ]
}

