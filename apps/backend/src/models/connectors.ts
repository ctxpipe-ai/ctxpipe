import { and, eq } from "drizzle-orm"
import { requireCurrentOrgId } from "src/auth/context.js"
import { connectors } from "src/db/schema/connectors.js"
import { generateObjectId } from "src/lib/id.js"
import { getOrgDb, getSystemDb } from "../db/client.js"

export type ConnectorRecord = typeof connectors.$inferSelect
export type ConnectorConfig = ConnectorRecord["config"]

export const listConnectors = async () => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  return db.query.connectors.findMany({
    where: { orgId: { eq: orgId } },
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  })
}

export const getConnector = async (connectorId: string) => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  return db.query.connectors.findFirst({
    where: {
      id: { eq: connectorId },
      orgId: { eq: orgId },
    },
  })
}

export const getConnectorByType = async (type: string) => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  return db.query.connectors.findFirst({
    where: {
      type: { eq: type },
      orgId: { eq: orgId },
    },
  })
}

export const createConnector = async (input: {
  type: string
  config: ConnectorConfig
  githubRepoId?: string
  githubRepoName?: string
  githubBranch?: string
}) => {
  const orgId = requireCurrentOrgId()
  const id = generateObjectId("conf")
  const db = getOrgDb()

  const [connector] = await db
    .insert(connectors)
    .values({
      id,
      orgId,
      type: input.type,
      config: input.config,
      githubRepoId: input.githubRepoId ?? null,
      githubRepoName: input.githubRepoName ?? null,
      githubBranch: input.githubBranch ?? "main",
      enabled: true,
    })
    .returning()

  if (connector) return connector
  throw new Error("Failed to create connector")
}

export const updateConnector = async (
  connectorId: string,
  input: Partial<{
    config: ConnectorConfig
    enabled: boolean
    githubRepoId: string
    githubRepoName: string
    githubBranch: string
    lastPrNumber: number
    lastSyncAt: Date
  }>,
) => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()

  const [updated] = await db
    .update(connectors)
    .set({
      ...input,
      updatedAt: new Date(),
    })
    .where(and(eq(connectors.id, connectorId), eq(connectors.orgId, orgId)))
    .returning()

  return updated ?? null
}

export const disableConnector = async (connectorId: string) => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()

  const [updated] = await db
    .update(connectors)
    .set({
      enabled: false,
      updatedAt: new Date(),
    })
    .where(and(eq(connectors.id, connectorId), eq(connectors.orgId, orgId)))
    .returning()

  return updated ?? null
}

export const enableConnector = async (connectorId: string) => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()

  const [updated] = await db
    .update(connectors)
    .set({
      enabled: true,
      updatedAt: new Date(),
    })
    .where(and(eq(connectors.id, connectorId), eq(connectors.orgId, orgId)))
    .returning()

  return updated ?? null
}

export const deleteConnector = async (connectorId: string) => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  const [deleted] = await db
    .delete(connectors)
    .where(and(eq(connectors.id, connectorId), eq(connectors.orgId, orgId)))
    .returning({ id: connectors.id })
  return deleted != null
}

export const getEnabledConnectors = async () => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  return db.query.connectors.findMany({
    where: {
      orgId: { eq: orgId },
      enabled: { eq: true },
    },
  })
}

/** System-level query: returns all enabled connectors across every org.
 *  Bypasses RLS — for use only in background workers. */
export const listAllEnabledConnectors = async () => {
  const db = getSystemDb()
  return db.query.connectors.findMany({
    where: { enabled: { eq: true } },
  })
}
