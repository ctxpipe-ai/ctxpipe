/**
 * Drizzle schema definitions. Add table definitions here and export them
 * for use in REST routes, MCP tools, and migrations.
 *
 * ID convention: primary keys use TEXT type, format `<prefix>_<base32 encoded uuid>`.
 */
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core"
import { connections } from "./connections.js"

export const repositoryIndexingStatusValues = [
  "queued",
  "running",
  "ready",
  "failed",
  "unindexing",
] as const
export const repositoryIndexingStatusEnum = pgEnum(
  "repository_indexing_status",
  repositoryIndexingStatusValues,
)

export const repositories = pgTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    gitUrl: text("git_url").notNull(),
    indexReady: boolean("index_ready").notNull().default(false),
    indexingStatus: repositoryIndexingStatusEnum("indexing_status"),
    indexingError: text("indexing_error"),
    indexingFailedAt: timestamp("indexing_failed_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastIngestedHash: text("last_ingested_hash"),
    lastIngestedAt: timestamp("last_ingested_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** When set, UI shows re-indexing state (e.g. after a merge webhook). Cleared when ingestion completes. */
    indexingReason: text("indexing_reason"),
    /** Current step index within the active indexing run (1-based). Cleared on ready/failed/unindexing. */
    indexingStep: integer("indexing_step"),
    /** Total steps expected for the current run. Cleared on ready/failed/unindexing. */
    indexingStepTotal: integer("indexing_step_total"),
    /** Canonical step key for the current step (e.g. "cloning", "scip:go"). Cleared on ready/failed/unindexing. */
    indexingStepKey: text("indexing_step_key"),
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
