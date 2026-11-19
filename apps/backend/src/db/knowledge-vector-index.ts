import pg from "pg"

import { log } from "../observability/logger.js"
import {
  HALF_EMBEDDING_INDEX,
  KNOWLEDGE_VECTOR_INDEX,
} from "./schema/workspaces.js"

/**
 * Builds the half-precision HNSW index of the chunk embeddings (`KNOWLEDGE_VECTOR_INDEX`) CONCURRENTLY, then drops the
 * full-precision one CONCURRENTLY (CTX-1380). Neither blocks a read or a write of the chunks. A concurrent build cannot
 * run in a transaction, so this runs after Drizzle's migrations, which run in one, on a connection of its own in
 * autocommit, which it closes after:
 *
 * - **Idempotent:** with the valid index there, it only drops the old one (if it is still there).
 * - **A failed build** leaves an invalid index; the next run drops it and builds again.
 * - **Old transactions:** a concurrent build waits for every transaction that may still see the table, so its lock
 *   wait is ten minutes, not migrate's 30 seconds. A build that waits longer is a warning: migrate goes on, the search
 *   scans a large scope exactly until the next migrate builds the index.
 */
export async function buildKnowledgeVectorIndex(
  connectionString: string,
): Promise<void> {
  const client = new pg.Client({ connectionString })
  await client.connect()
  try {
    await client.query("SET lock_timeout = '10min'")
    const found = await client.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace`,
      [KNOWLEDGE_VECTOR_INDEX],
    )
    if (found.rows[0]?.valid !== true) {
      await client.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "${KNOWLEDGE_VECTOR_INDEX}"`,
      )
      const started = performance.now()
      await client.query(
        `CREATE INDEX CONCURRENTLY "${KNOWLEDGE_VECTOR_INDEX}" ON "workspace_knowledge_chunks" USING hnsw (${HALF_EMBEDDING_INDEX})`,
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
    // The full-precision index, which no query reads after this change.
    await client.query(
      'DROP INDEX CONCURRENTLY IF EXISTS "workspace_knowledge_chunks_embedding_idx"',
    )
  } catch (error) {
    if ((error as { code?: string }).code !== "55P03") throw error
    log.warn({
      step: "migrate",
      message:
        "[migrate] the half-precision HNSW index was not built: older transactions held the table for 10 minutes. The next migrate builds it.",
      index: KNOWLEDGE_VECTOR_INDEX,
    })
  } finally {
    await client.end()
  }
}
