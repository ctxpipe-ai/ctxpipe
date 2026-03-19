import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { connectors } from "./connectors.js"

export const connectorSyncLogs = pgTable(
  "connector_sync_logs",
  {
    id: text("id").primaryKey(),
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    pagesAdded: integer("pages_added").default(0),
    pagesUpdated: integer("pages_updated").default(0),
    pagesDeleted: integer("pages_deleted").default(0),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => [
    index().on(t.connectorId, t.startedAt),
    index().on(t.connectorId, t.status),
  ],
)
