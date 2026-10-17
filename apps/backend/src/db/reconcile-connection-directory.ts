import { notExists, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import type { Pool } from "pg"
import { directoryValuesFromConnection } from "../models/connection-directory.js"
import { connectionDirectory, connections } from "./schema/connections.js"

/**
 * Make `connection_directory` agree with `connections` for every connection
 * type. Code from before the directory writes `connections` only, so in each
 * rollback window and each deploy window the directory can miss a new
 * connection or keep a deleted one. Then webhooks drop with no error. Run it as
 * the table owner, which RLS does not filter. A second run changes no row.
 */
export async function reconcileConnectionDirectory(
  pool: Pool,
): Promise<{ upserted: number; deleted: number }> {
  const db = drizzle({ client: pool })
  return db.transaction(async (tx) => {
    // RLS hides every connection from a role that does not own the table, and
    // then the delete below would empty the directory.
    const owner = await tx.execute<{ bypass: boolean }>(sql`
      SELECT pg_has_role(current_user, c.relowner, 'USAGE') OR r.rolbypassrls AS bypass
      FROM pg_catalog.pg_class c, pg_catalog.pg_roles r
      WHERE c.oid = 'public.connections'::regclass AND r.rolname = current_user`)
    if (!owner.rows[0]?.bypass) {
      throw new Error(
        "[migrate] reconcile connection_directory needs the owner of connections; RLS hides its rows from this role",
      )
    }
    const rows = await tx
      .select({
        id: connections.id,
        orgId: connections.orgId,
        type: connections.type,
        config: connections.config,
      })
      .from(connections)
    const values = rows.map(directoryValuesFromConnection)
    for (let start = 0; start < values.length; start += 500) {
      await tx
        .insert(connectionDirectory)
        .values(values.slice(start, start + 500))
        .onConflictDoUpdate({
          target: connectionDirectory.connectionId,
          set: {
            orgId: sql`excluded.org_id`,
            type: sql`excluded.type`,
            githubInstallationId: sql`excluded.github_installation_id`,
            slackTeamId: sql`excluded.slack_team_id`,
            linearWorkspaceId: sql`excluded.linear_workspace_id`,
            notionWorkspaceId: sql`excluded.notion_workspace_id`,
            notionBotId: sql`excluded.notion_bot_id`,
            forgeCloudId: sql`excluded.forge_cloud_id`,
            forgeInstallationId: sql`excluded.forge_installation_id`,
            updatedAt: sql`excluded.updated_at`,
          },
          // A row that already agrees keeps its updated_at, so a second
          // migrate writes nothing.
          setWhere: sql`(
            ${connectionDirectory.orgId}, ${connectionDirectory.type},
            ${connectionDirectory.githubInstallationId}, ${connectionDirectory.slackTeamId},
            ${connectionDirectory.linearWorkspaceId}, ${connectionDirectory.notionWorkspaceId},
            ${connectionDirectory.notionBotId}, ${connectionDirectory.forgeCloudId},
            ${connectionDirectory.forgeInstallationId}
          ) IS DISTINCT FROM (
            excluded.org_id, excluded.type, excluded.github_installation_id,
            excluded.slack_team_id, excluded.linear_workspace_id,
            excluded.notion_workspace_id, excluded.notion_bot_id,
            excluded.forge_cloud_id, excluded.forge_installation_id
          )`,
        })
    }
    // After the upsert: this statement sees a connection that old code
    // deleted while the upsert ran, and removes its row too.
    const deleted = await tx
      .delete(connectionDirectory)
      .where(
        notExists(
          tx
            .select({ id: connections.id })
            .from(connections)
            .where(
              sql`${connections.id} = ${connectionDirectory.connectionId}`,
            ),
        ),
      )
      .returning({ connectionId: connectionDirectory.connectionId })
    return { upserted: values.length, deleted: deleted.length }
  })
}
