import { boolean, index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core"
import { connections } from "./connections.js"

/** Draft / selected Slack channels for a connection (config PR source). */
export const slackChannels = pgTable(
  "slack_channels",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    name: text("name").notNull(),
    isPrivate: boolean("is_private").notNull().default(false),
    lastSyncedAt: timestamp("last_synced_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** Backfill checkpoint cursor from conversations.history (opaque). */
    backfillCursor: text("backfill_cursor"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("slack_channels_connection_id_idx").on(t.connectionId),
    unique("slack_channels_connection_channel_id_uq").on(
      t.connectionId,
      t.channelId,
    ),
  ],
)
