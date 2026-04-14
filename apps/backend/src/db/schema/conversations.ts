import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { users } from "./auth.js"

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    /** Better Auth user id; conversations are private to this user within the org. */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("New Chat"),
    source: text("source"),
    lastMessageAt: timestamp("last_message_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index().on(t.orgId, t.userId, t.lastMessageAt),
    index().on(t.orgId, t.userId, t.source),
    index().on(t.orgId, t.userId, t.updatedAt),
  ],
)
