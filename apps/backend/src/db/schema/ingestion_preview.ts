import { index, pgTable, primaryKey, text } from "drizzle-orm/pg-core"
import { repositories } from "./repositories.js"

/**
 * Provisional graph for a repository while it ingests: what the extractors
 * have found so far, before deduplication and projection. Onboarding shows
 * it so the graph visibly builds. Cleared at the start of a run and once
 * the run's claims are projected into the real graph.
 */
export const ingestionPreviewNodes = pgTable(
  "ingestion_preview_nodes",
  {
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    /** Deduplication key or object id, as the extractor referenced it. */
    nodeKey: text("node_key").notNull(),
    kind: text("kind").notNull(),
    name: text("name"),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.nodeKey] }),
    index().on(t.orgId),
  ],
)

export const ingestionPreviewLinks = pgTable(
  "ingestion_preview_links",
  {
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    sourceKey: text("source_key").notNull(),
    targetKey: text("target_key").notNull(),
    predicate: text("predicate").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.repositoryId, t.sourceKey, t.targetKey, t.predicate],
    }),
    index().on(t.orgId),
  ],
)
