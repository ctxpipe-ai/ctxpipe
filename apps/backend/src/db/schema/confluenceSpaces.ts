import { index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core"
import { forgeInstallations } from "./forgeInstallations.js"

export const confluenceSpaces = pgTable(
  "confluence_spaces",
  {
    id: text("id").primaryKey(),
    forgeInstallationId: text("forge_installation_id")
      .notNull()
      .references(() => forgeInstallations.id, { onDelete: "cascade" }),
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
    index().on(t.forgeInstallationId),
    unique("confluence_spaces_forge_installation_space_key_uq").on(
      t.forgeInstallationId,
      t.spaceKey,
    ),
  ],
)
