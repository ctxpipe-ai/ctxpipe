import { sql } from "drizzle-orm"
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  vector,
} from "drizzle-orm/pg-core"
import { organizations } from "./auth.js"
import { tenantRlsPolicies } from "./rls.js"

/** Qwen3 Embedding 8B with MRL: 2000 dims for pgvector HNSW index compatibility */
const EMBEDDING_DIMENSIONS = 2000

export const objects = pgTable.withRLS(
  "objects",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    deduplicationKey: text("deduplication_key"),
    payload: jsonb("payload").notNull(),
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS,
    }),
    searchContent: text("search_content"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index().on(t.orgId),
    index().on(t.kind),
    index().on(t.orgId, t.kind),
    index().on(t.orgId, t.deduplicationKey),
    ...tenantRlsPolicies("objects", t.orgId),
    index("retrieval_embeddings_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    index("retrieval_search_content_fts_idx").using(
      "gin",
      sql`to_tsvector('english', ${t.searchContent})`,
    ),
  ],
)
