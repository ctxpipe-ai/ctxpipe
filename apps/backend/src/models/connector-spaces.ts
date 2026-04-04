import { and, eq } from "drizzle-orm"
import { connectorSpaces } from "src/db/schema/connector-spaces.js"
import { connectors } from "src/db/schema/connectors.js"
import { generateObjectId } from "src/lib/id.js"
import { getOrgDb } from "../db/client.js"
import { requireCurrentOrgId } from "src/auth/context.js"

export type ConnectorSpaceRecord = typeof connectorSpaces.$inferSelect

export const listConnectorSpaces = async (connectorId: string) => {
  const db = getOrgDb()
  return db.query.connectorSpaces.findMany({
    where: {
      connectorId: { eq: connectorId },
    },
  })
}

export const getConnectorSpace = async (
  connectorId: string,
  spaceKey: string,
) => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  return db.query.connectorSpaces.findFirst({
    where: {
      connectorId: { eq: connectorId },
      spaceKey: { eq: spaceKey },
    },
  })
}

export const createConnectorSpace = async (input: {
  connectorId: string
  spaceKey: string
  spaceName?: string
  selectedPageIds?: string[] | null
}) => {
  const id = generateObjectId("csp")
  const db = getOrgDb()

  const [space] = await db
    .insert(connectorSpaces)
    .values({
      id,
      connectorId: input.connectorId,
      spaceKey: input.spaceKey,
      spaceName: input.spaceName ?? null,
      selectedPageIds: input.selectedPageIds ?? null,
    })
    .returning()

  if (space) return space
  throw new Error("Failed to create connector space")
}

export const createConnectorSpaces = async (input: {
  connectorId: string
  spaces: Array<{ spaceKey: string; spaceName?: string; selectedPageIds?: string[] | null }>
}) => {
  const db = getOrgDb()
  const values = input.spaces.map((s) => ({
    id: generateObjectId("csp"),
    connectorId: input.connectorId,
    spaceKey: s.spaceKey,
    spaceName: s.spaceName ?? null,
    selectedPageIds: s.selectedPageIds ?? null,
  }))

  const created = await db
    .insert(connectorSpaces)
    .values(values)
    .onConflictDoNothing({
      target: [connectorSpaces.connectorId, connectorSpaces.spaceKey],
    })
    .returning()
  return created
}

export const updateConnectorSpace = async (
  spaceId: string,
  input: Partial<{
    spaceName: string
    selectedPageIds: string[] | null
    lastSyncedPageId: string
    lastSyncedAt: Date
  }>,
) => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()

  const [space] = await db
    .select()
    .from(connectorSpaces)
    .innerJoin(connectors, eq(connectors.id, connectorSpaces.connectorId))
    .where(and(eq(connectorSpaces.id, spaceId), eq(connectors.orgId, orgId)))
    .limit(1)

  if (!space) return null

  const [updated] = await db
    .update(connectorSpaces)
    .set({
      ...input,
      updatedAt: new Date(),
    })
    .where(eq(connectorSpaces.id, spaceId))
    .returning()

  return updated ?? null
}

export const deleteConnectorSpace = async (spaceId: string) => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()

  const [space] = await db
    .select()
    .from(connectorSpaces)
    .innerJoin(connectors, eq(connectors.id, connectorSpaces.connectorId))
    .where(and(eq(connectorSpaces.id, spaceId), eq(connectors.orgId, orgId)))
    .limit(1)

  if (!space) return false

  const [deleted] = await db
    .delete(connectorSpaces)
    .where(eq(connectorSpaces.id, spaceId))
    .returning({ id: connectorSpaces.id })

  return deleted != null
}

export const deleteConnectorSpaces = async (connectorId: string) => {
  const db = getOrgDb()
  await db
    .delete(connectorSpaces)
    .where(eq(connectorSpaces.connectorId, connectorId))
}

export const replaceConnectorSpaces = async (input: {
  connectorId: string
  spaces: Array<{ spaceKey: string; spaceName?: string; selectedPageIds?: string[] | null }>
}) => {
  const db = getOrgDb()
  await db
    .delete(connectorSpaces)
    .where(eq(connectorSpaces.connectorId, input.connectorId))

  if (input.spaces.length === 0) return []

  const values = input.spaces.map((s) => ({
    id: generateObjectId("csp"),
    connectorId: input.connectorId,
    spaceKey: s.spaceKey,
    spaceName: s.spaceName ?? null,
    selectedPageIds: s.selectedPageIds ?? null,
  }))

  return db.insert(connectorSpaces).values(values).returning()
}
