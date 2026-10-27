import { and, eq, sql } from "drizzle-orm"

import { withOrgDbContext } from "../db/client.js"
import { connections } from "../db/schema/connections.js"
import type {
  ForgeSourceSync,
  NotionSourceSync,
  PagerdutySourceSync,
  PlainSourceSync,
} from "../lib/connection-config.js"

/**
 * Save the Workspace sources sync state of a connection (ADR-050). It changes
 * only `config.sourceSync`, so a concurrent edit of other keys (for example a
 * token refresh) stays.
 */
export async function saveConnectionSourceSync(
  input: { orgId: string; connectionId: string } & (
    | { type: "forge"; sourceSync: ForgeSourceSync }
    | { type: "notion"; sourceSync: NotionSourceSync }
    | { type: "pagerduty"; sourceSync: PagerdutySourceSync }
    | { type: "plain"; sourceSync: PlainSourceSync }
  ),
): Promise<void> {
  await withOrgDbContext(input.orgId, (db) =>
    db
      .update(connections)
      .set({
        config: sql`jsonb_set(${connections.config}, '{sourceSync}', ${JSON.stringify(input.sourceSync)}::jsonb)`,
      })
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, input.type),
        ),
      ),
  )
}
