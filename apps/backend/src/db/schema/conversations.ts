import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { tenantRlsPolicies } from "./rls.js"

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    /** Set on new rows; legacy rows may be null until backfilled */
    userId: text("user_id"),
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
    index().on(t.orgId, t.lastMessageAt),
    index().on(t.orgId, t.source),
    index().on(t.orgId, t.updatedAt),
    index().on(t.orgId, t.userId, t.lastMessageAt),
    ...tenantRlsPolicies("conversations", t.orgId),
  ],
)
