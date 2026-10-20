import { eq } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"

export async function getOrganizationSlugByOrgId(
  orgId: string,
): Promise<string | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  return row?.slug
}
