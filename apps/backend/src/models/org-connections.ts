import { asc, eq } from "drizzle-orm"
import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { type ConnectionType, connections } from "../db/schema/connections.js"

export type OrgConnectionListItem = {
  id: string
  type: ConnectionType
  createdAt: Date
  updatedAt: Date
}

/** Metadata only — never exposes `config` (secrets). */
export async function listOrgConnections(
  orgId: string,
): Promise<OrgConnectionListItem[]> {
  return withOrgDbContext(orgId, async () => {
    return getOrgDb()
      .select({
        id: connections.id,
        type: connections.type,
        createdAt: connections.createdAt,
        updatedAt: connections.updatedAt,
      })
      .from(connections)
      .where(eq(connections.orgId, orgId))
      .orderBy(asc(connections.createdAt))
  })
}
