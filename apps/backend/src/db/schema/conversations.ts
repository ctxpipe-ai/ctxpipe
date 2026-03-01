import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull().default("New Chat"),
    source: text("source").notNull().default("ui"),
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
    index().on(t.orgId, t.lastMessageAt),
    index().on(t.orgId, t.source),
    index().on(t.orgId, t.updatedAt),
  ],
)
