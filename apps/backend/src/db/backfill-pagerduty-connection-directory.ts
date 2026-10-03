import { and, eq } from "drizzle-orm"
import {
  getConnectionDirectoryByConnectionId,
  upsertConnectionDirectory,
} from "../models/connection-directory.js"
import { getSystemDb, withOrgDbContext } from "./client.js"
import { organizations } from "./schema/auth.js"
import { CONNECTION_TYPE_PAGERDUTY, connections } from "./schema/connections.js"

/** Repair historical PagerDuty connections that never got a directory row. */
export async function backfillMissingPagerdutyConnectionDirectory(scope?: {
  orgId?: string
}): Promise<number> {
  const orgIds = scope?.orgId
    ? [scope.orgId]
    : (
        await getSystemDb().select({ id: organizations.id }).from(organizations)
      ).map((row) => row.id)

  let inserted = 0
  for (const orgId of orgIds) {
    inserted += await withOrgDbContext(orgId, async (db) => {
      const rows = await db
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.orgId, orgId),
            eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
          ),
        )
      let count = 0
      for (const row of rows) {
        if (await getConnectionDirectoryByConnectionId(row.id)) continue
        await upsertConnectionDirectory(row)
        count += 1
      }
      return count
    })
  }
  return inserted
}
