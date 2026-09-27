import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withUserIdContext } from "../auth/context.js"
import { withOrgIdContext } from "../auth/withAuth.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { conversations } from "../db/schema/conversations.js"
import { generateObjectId } from "../lib/id.js"
import { ensureConversation } from "./conversations.js"

const connectionString = process.env.DATABASE_URL
const orgId = generateObjectId("org")
const conversationId = generateObjectId("conv")
const privateConversationId = generateObjectId("conv")

describe.skipIf(!connectionString)("conversation first-send race (Postgres)", () => {
  beforeAll(async () => {
    if (!connectionString) return
    initDb(connectionString)
    await getSystemDb().insert(organizations).values({
      id: orgId,
      name: "Conversation race integration",
      slug: `conversation-race-${orgId}`,
      createdAt: new Date(),
    })
  })

  afterAll(async () => {
    if (!connectionString) return
    await withOrgDbContext(orgId, (db) =>
      db.delete(conversations).where(eq(conversations.id, conversationId)),
    )
    await withOrgDbContext(orgId, (db) =>
      db.delete(conversations).where(eq(conversations.id, privateConversationId)),
    )
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await closeDb()
  })

  it("lets concurrent send and prepare resolve the same conversation", async () => {
    const rows = await withOrgIdContext(
      { id: orgId, slug: `conversation-race-${orgId}` },
      () =>
        withUserIdContext("user_conversation_race", () =>
          Promise.all(
            Array.from({ length: 8 }, () =>
              ensureConversation({ id: conversationId, source: "ui" }),
            ),
          ),
        ),
    )

    expect(rows).toHaveLength(8)
    expect(rows.every((row) => row.id === conversationId)).toBe(true)
    expect(rows.every((row) => row.userId === "user_conversation_race")).toBe(
      true,
    )
  })

  it("does not let another user claim an existing conversation id", async () => {
    await withOrgIdContext(
      { id: orgId, slug: `conversation-race-${orgId}` },
      async () => {
        const owner = await withUserIdContext("user_conversation_owner", () =>
          ensureConversation({ id: privateConversationId, source: "ui" }),
        )
        expect(owner.userId).toBe("user_conversation_owner")

        await expect(
          withUserIdContext("user_conversation_other", () =>
            ensureConversation({ id: privateConversationId, source: "ui" }),
          ),
        ).rejects.toMatchObject({ status: 404 })
      },
    )
  })
})
