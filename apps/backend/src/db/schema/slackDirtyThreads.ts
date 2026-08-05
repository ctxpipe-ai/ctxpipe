import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core"
import { connections } from "./connections.js"

/**
 * Dirty thread keys for coalesced Slack → Git flushes.
 * Marked on Events API; cleared after a successful flush upsert.
 */
export const slackDirtyThreads = pgTable(
  "slack_dirty_threads",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    /** First time this key became dirty in the current dirty window. */
    firstDirtyAt: timestamp("first_dirty_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    /** Last event that refreshed this dirty key (resets coalesce quiet period). */
    lastEventAt: timestamp("last_event_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("slack_dirty_threads_connection_id_idx").on(t.connectionId),
    index("slack_dirty_threads_flush_idx").on(
      t.connectionId,
      t.lastEventAt,
      t.firstDirtyAt,
    ),
    unique("slack_dirty_threads_connection_channel_thread_uq").on(
      t.connectionId,
      t.channelId,
      t.threadTs,
    ),
  ],
)
