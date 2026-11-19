import type { Pool } from "pg"

import { log } from "../observability/logger.js"
import { EMBEDDING_DIMENSIONS } from "./schema/objects.js"
import { KNOWLEDGE_VECTOR_INDEX } from "./schema/workspaces.js"

/** The full-precision HNSW index of the chunk embeddings, which the half-precision one replaces (CTX-1380). */
const OLD_INDEX = "workspace_knowledge_chunks_embedding_idx"

/**
 * Builds the half-precision HNSW index of the chunk embeddings (`KNOWLEDGE_VECTOR_INDEX`) CONCURRENTLY, then drops the
 * full-precision one CONCURRENTLY. Neither blocks a read or a write of the chunks. A concurrent build cannot run in a
 * transaction, so this runs after Drizzle's migrations, on one connection of its own, in autocommit:
 *
 * - **Idempotent:** with the valid index there, it only drops the old one (if it is still there).
 * - **A failed build** (a lock wait, a restart) leaves an invalid index; the next run drops it and builds again.
 * - **Old transactions:** a concurrent build waits for every transaction that may still see the table, so the lock wait
 *   here is ten minutes, not migrate's 30 seconds.
 * - **Search meanwhile:** until the new index is valid the search orders by an expression that no index holds, so a
 *   large scope reads its vectors exactly, as before; the old index serves no query of the search after this deploy.
 */
export async function buildKnowledgeVectorIndex(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query("SET lock_timeout = '10min'")
    const found = await client.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace`,
      [KNOWLEDGE_VECTOR_INDEX],
    )
    if (found.rows[0]?.valid !== true) {
      if (found.rows.length > 0) {
        await client.query(
          `DROP INDEX CONCURRENTLY IF EXISTS "${KNOWLEDGE_VECTOR_INDEX}"`,
        )
      }
      const started = performance.now()
      await client.query(
        `CREATE INDEX CONCURRENTLY "${KNOWLEDGE_VECTOR_INDEX}" ON "workspace_knowledge_chunks"
         USING hnsw (("embedding"::halfvec(${EMBEDDING_DIMENSIONS})) halfvec_cosine_ops)`,
      )
      const chunks = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM workspace_knowledge_chunks WHERE embedding IS NOT NULL",
      )
      log.info({
        step: "migrate",
        message:
          "[migrate] built the half-precision HNSW index of the chunk embeddings",
        index: KNOWLEDGE_VECTOR_INDEX,
        embeddings: Number(chunks.rows[0]?.n ?? 0),
        seconds: Math.round((performance.now() - started) / 1000),
      })
    }
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${OLD_INDEX}"`)
  } finally {
    client.release()
  }
}
