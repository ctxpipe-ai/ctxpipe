import { and, eq } from "drizzle-orm"
import { getOrgDb } from "../db/client.js"
import { objects } from "../db/schema/objects.js"
import { generateObjectId } from "../lib/id.js"

/** Historical database content for migration/poison fixtures; runtime extraction writes Git. */
export async function seedLegacyExtractionObject(
  orgId: string,
  input: {
    kind: string
    deduplicationKey: string
    payload: Record<string, unknown>
  },
) {
  const db = getOrgDb()
  const [existing] = await db
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.deduplicationKey, input.deduplicationKey),
      ),
    )
    .limit(1)
  if (existing) {
    await db
      .update(objects)
      .set({ payload: input.payload, updatedAt: new Date() })
      .where(eq(objects.id, existing.id))
    return { id: existing.id }
  }
  const id = generateObjectId("obj")
  await db.insert(objects).values({ id, orgId, ...input })
  return { id }
}
