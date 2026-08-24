import { eq } from "drizzle-orm"
import { getOrgDb, getSystemDb, withOrgDbContext } from "../db/client.js"
import {
  type ConnectionType,
  connectionDirectory,
  connections,
} from "../db/schema/connections.js"
import type { ConnectionRow } from "./connection-rows.js"

export type ConnectionDirectoryRow = typeof connectionDirectory.$inferSelect

function nonemptyText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function directoryValuesFromConnection(row: {
  id: string
  orgId: string
  type: ConnectionType
  config: Record<string, unknown>
}): typeof connectionDirectory.$inferInsert {
  const config = row.config
  return {
    connectionId: row.id,
    orgId: row.orgId,
    type: row.type,
    githubInstallationId:
      row.type === "github" ? nonemptyText(config.installationId) : null,
    slackTeamId: row.type === "slack" ? nonemptyText(config.teamId) : null,
    linearWorkspaceId:
      row.type === "linear" ? nonemptyText(config.workspaceId) : null,
    notionWorkspaceId:
      row.type === "notion" ? nonemptyText(config.workspaceId) : null,
    notionBotId: row.type === "notion" ? nonemptyText(config.botId) : null,
    forgeCloudId: row.type === "forge" ? nonemptyText(config.cloudId) : null,
    forgeInstallationId:
      row.type === "forge" ? nonemptyText(config.installationId) : null,
    updatedAt: new Date(),
  }
}

/** UnRLS'd webhook bootstrap. Do not store secrets here. */
export async function upsertConnectionDirectory(
  row: ConnectionRow,
): Promise<void> {
  const values = directoryValuesFromConnection({
    id: row.id,
    orgId: row.orgId,
    type: row.type,
    config: row.config as Record<string, unknown>,
  })
  const db = getSystemDb()
  await db
    .insert(connectionDirectory)
    .values(values)
    .onConflictDoUpdate({
      target: connectionDirectory.connectionId,
      set: {
        orgId: values.orgId,
        type: values.type,
        githubInstallationId: values.githubInstallationId,
        slackTeamId: values.slackTeamId,
        linearWorkspaceId: values.linearWorkspaceId,
        notionWorkspaceId: values.notionWorkspaceId,
        notionBotId: values.notionBotId,
        forgeCloudId: values.forgeCloudId,
        forgeInstallationId: values.forgeInstallationId,
        updatedAt: values.updatedAt,
      },
    })
}

export async function deleteConnectionDirectory(
  connectionId: string,
): Promise<void> {
  await getSystemDb()
    .delete(connectionDirectory)
    .where(eq(connectionDirectory.connectionId, connectionId))
}

export async function getConnectionDirectoryByConnectionId(
  connectionId: string,
): Promise<ConnectionDirectoryRow | undefined> {
  const [row] = await getSystemDb()
    .select()
    .from(connectionDirectory)
    .where(eq(connectionDirectory.connectionId, connectionId))
    .limit(1)
  return row
}

export async function listConnectionDirectoryByGithubInstallationId(
  githubInstallationId: number,
): Promise<ConnectionDirectoryRow[]> {
  return getSystemDb()
    .select()
    .from(connectionDirectory)
    .where(
      eq(
        connectionDirectory.githubInstallationId,
        String(githubInstallationId),
      ),
    )
}

export async function listConnectionDirectoryBySlackTeamId(
  teamId: string,
): Promise<ConnectionDirectoryRow[]> {
  return getSystemDb()
    .select()
    .from(connectionDirectory)
    .where(eq(connectionDirectory.slackTeamId, teamId))
}

export async function listConnectionDirectoryByLinearWorkspaceId(
  workspaceId: string,
): Promise<ConnectionDirectoryRow[]> {
  return getSystemDb()
    .select()
    .from(connectionDirectory)
    .where(eq(connectionDirectory.linearWorkspaceId, workspaceId))
}

export async function listConnectionDirectoryByNotionWorkspaceId(
  workspaceId: string,
): Promise<ConnectionDirectoryRow[]> {
  return getSystemDb()
    .select()
    .from(connectionDirectory)
    .where(eq(connectionDirectory.notionWorkspaceId, workspaceId))
}

export async function listConnectionDirectoryByNotionBotId(
  botId: string,
): Promise<ConnectionDirectoryRow[]> {
  return getSystemDb()
    .select()
    .from(connectionDirectory)
    .where(eq(connectionDirectory.notionBotId, botId))
}

export async function listConnectionDirectoryByForgeInstallationId(
  installationId: string,
): Promise<ConnectionDirectoryRow[]> {
  return getSystemDb()
    .select()
    .from(connectionDirectory)
    .where(eq(connectionDirectory.forgeInstallationId, installationId))
}

export async function listConnectionDirectoryByForgeCloudId(
  cloudId: string,
): Promise<ConnectionDirectoryRow[]> {
  return getSystemDb()
    .select()
    .from(connectionDirectory)
    .where(eq(connectionDirectory.forgeCloudId, cloudId))
}

/** Load a tenant `connections` row after directory bootstrap. */
export async function loadConnectionViaDirectory(
  connectionId: string,
): Promise<ConnectionRow | undefined> {
  const dir = await getConnectionDirectoryByConnectionId(connectionId)
  if (!dir) return undefined
  return withOrgDbContext(dir.orgId, async () => {
    const [row] = await getOrgDb()
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1)
    return row
  })
}
