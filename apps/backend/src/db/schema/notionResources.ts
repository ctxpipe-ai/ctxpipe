import { index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core"
import { connections } from "./connections.js"

export const notionResources = pgTable(
  "notion_resources",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    type: text("type").$type<"page" | "database">().notNull(),
    title: text("title").notNull(),
    url: text("url"),
    parentExternalId: text("parent_external_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => [
    index("notion_resources_connection_id_idx").on(t.connectionId),
    unique("notion_resources_connection_external_id_uq").on(
      t.connectionId,
      t.externalId,
    ),
  ],
)
