/**
 * Drizzle schema definitions. Add table definitions here and export them
 * for use in REST routes, MCP tools, and migrations.
 *
 * ID convention: primary keys use TEXT type, format `<prefix>_<base32 encoded uuid>`.
 */
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core"
import { connections } from "./connections.js"

export const repositories = pgTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    gitUrl: text("git_url").notNull(),
    indexReady: boolean("index_ready").notNull().default(false),
    lastIngestedHash: text("last_ingested_hash"),
    /** When set, UI shows re-indexing state (e.g. after a merge webhook). Cleared when ingestion completes. */
    indexingReason: text("indexing_reason"),
    githubConnectionId: text("github_connection_id").references(
      () => connections.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique().on(t.name, t.orgId),
    unique().on(t.gitUrl, t.orgId),
    index().on(t.name),
    index("repositories_github_connection_id_idx").on(t.githubConnectionId),
  ],
)
