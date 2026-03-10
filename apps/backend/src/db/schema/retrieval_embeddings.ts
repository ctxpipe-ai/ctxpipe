import { index, pgTable, text, timestamp, vector } from "drizzle-orm/pg-core"
import { retrievalObjects } from "./retrieval_objects.js"

/** Qwen3 Embedding 8B with MRL: 2000 dims for pgvector HNSW index compatibility */
const EMBEDDING_DIMENSIONS = 2000

export const retrievalEmbeddings = pgTable(
  "retrieval_embeddings",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    objectId: text("object_id")
      .notNull()
      .references(() => retrievalObjects.id, { onDelete: "cascade" }),
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index().on(t.orgId),
    index().on(t.objectId),
    index("retrieval_embeddings_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  ],
)
