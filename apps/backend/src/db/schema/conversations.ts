import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core"

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
    lastChatPrNumber: integer("last_chat_pr_number"),
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

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    seq: integer("seq").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("conversation_messages_conversation_id_seq_uidx").on(
      t.conversationId,
      t.seq,
    ),
    index("conversation_messages_conversation_id_idx").on(t.conversationId),
  ],
)
