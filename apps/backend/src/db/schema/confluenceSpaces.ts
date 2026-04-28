import { index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core"
import { connections } from "./connections.js"

export const confluenceSpaces = pgTable(
  "confluence_spaces",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    spaceKey: text("space_key").notNull(),
    spaceName: text("space_name"),
    // null = sync all pages in space; string[] = only sync selected page IDs
    selectedPageIds: jsonb("selected_page_ids").$type<string[] | null>(),
    lastSyncedPageId: text("last_synced_page_id"),
    lastSyncedAt: timestamp("last_synced_at", {
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
    index().on(t.connectionId),
    unique("confluence_spaces_connection_space_key_uq").on(
      t.connectionId,
      t.spaceKey,
    ),
  ],
)
