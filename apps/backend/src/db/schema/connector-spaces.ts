import { index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core"
import { connectors } from "./connectors.js"

export const connectorSpaces = pgTable(
  "connector_spaces",
  {
    id: text("id").primaryKey(),
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    spaceKey: text("space_key").notNull(),
    spaceName: text("space_name"),
    // null = sync all pages in space; string[] = only sync these page IDs
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
    index().on(t.connectorId),
    unique("connector_spaces_connector_id_space_key_unique").on(t.connectorId, t.spaceKey),
  ],
)
