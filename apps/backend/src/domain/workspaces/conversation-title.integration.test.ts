import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { withUserIdContext } from "../../auth/context.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { conversations } from "../../db/schema/conversations.js"
import { generateObjectId } from "../../lib/id.js"
import {
  ensureConversation,
  getConversation,
  updateConversation,
} from "../../models/conversations.js"
import { nameConversationIfUnnamed } from "./conversation-title.js"

const orgId = generateObjectId("org")
const org = { id: orgId, slug: `conversation-title-${orgId}` }
const userId = "user_conversation_title"
const renamedId = generateObjectId("conv")
const unnamedId = generateObjectId("conv")

function asUser<T>(run: () => Promise<T>): Promise<T> {
  return withOrgIdContext(org, () => withUserIdContext(userId, run))
}

describe("automatic conversation title (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
    await getSystemDb().insert(organizations).values({
      id: orgId,
      name: "Conversation title integration",
      slug: org.slug,
      createdAt: new Date(),
    })
  })

  afterAll(async () => {
    await withOrgDbContext(orgId, (db) =>
      db.delete(conversations).where(eq(conversations.orgId, orgId)),
    )
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await closeDb()
  })

  it("keeps the user's name when the user renames while the title is made", async () => {
    const result = await asUser(async () => {
      await ensureConversation({ id: renamedId, source: "ui" })
      return nameConversationIfUnnamed({
        conversationId: renamedId,
        prompt: "Where is the billing ledger?",
        generate: async () => {
          // The user saves a name before the model replies.
          await updateConversation(renamedId, { name: "My billing notes" })
          return "Billing ledger"
        },
      })
    })

    expect(result).toBeNull()
    const stored = await asUser(() => getConversation(renamedId))
    expect(stored?.name).toBe("My billing notes")
  })

  it("names a conversation that is still unnamed", async () => {
    const result = await asUser(async () => {
      await ensureConversation({ id: unnamedId, source: "ui" })
      return nameConversationIfUnnamed({
        conversationId: unnamedId,
        prompt: "Where is the billing ledger?",
        generate: async () => "Billing ledger",
      })
    })

    expect(result).toBe("Billing ledger")
    const stored = await asUser(() => getConversation(unnamedId))
    expect(stored?.name).toBe("Billing ledger")
  })
})
