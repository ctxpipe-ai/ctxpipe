import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    /** Set on new rows; legacy rows may be null until backfilled */
    userId: text("user_id"),
    workspaceId: text("workspace_id"),
    name: text("name").notNull().default("New conversation"),
    source: text("source"),
    lastBranch: text("last_branch"),
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
    index().on(t.orgId, t.workspaceId, t.userId, t.lastMessageAt),
  ],
)
