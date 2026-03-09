import { index, pgTable, text } from "drizzle-orm/pg-core"
import { retrievalObjects } from "./retrieval_objects.js"

/**
 * Stores searchable content for BM25 full-text search.
 * Use to_tsvector(content) in queries for ts_rank.
 */
export const retrievalSearch = pgTable(
  "retrieval_search",
  {
    objectId: text("object_id")
      .primaryKey()
      .references(() => retrievalObjects.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
  },
  (t) => [index().on(t.content)],
)
