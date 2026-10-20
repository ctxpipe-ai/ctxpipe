import { type SQLWrapper, sql } from "drizzle-orm"
import { pgPolicy } from "drizzle-orm/pg-core"

const orgGuc = sql.raw("current_setting('app.organization_id', true)")

/** ENABLE-only policy: missing GUC → no rows (NULL = unknown). Owner bypasses ENABLE. */
export function orgIsolationPolicy(orgIdColumn: SQLWrapper) {
  return pgPolicy("org_isolation", {
    as: "permissive",
    for: "all",
    to: "public",
    using: sql`${orgIdColumn} = ${orgGuc}`,
    withCheck: sql`${orgIdColumn} = ${orgGuc}`,
  })
}
