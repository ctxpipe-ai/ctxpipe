import pg from "pg"

import { log } from "../observability/logger.js"
import {
  HALF_EMBEDDING_INDEX,
  KNOWLEDGE_SEARCH_INDEX,
  KNOWLEDGE_SEARCH_INDEX_COLUMNS,
  KNOWLEDGE_UNIT_INDEX,
  KNOWLEDGE_UNIT_INDEX_COLUMNS,
  KNOWLEDGE_VECTOR_INDEX,
} from "./schema/workspaces.js"

/** The indexes of the chunks that runMigrations builds concurrently, each with the one that it replaces (CTX-1380, CTX-1708). */
const INDEXES = [
  {
    name: KNOWLEDGE_VECTOR_INDEX,
    using: `hnsw (${HALF_EMBEDDING_INDEX})`,
    replaces: "workspace_knowledge_chunks_embedding_idx",
  },
  {
    name: KNOWLEDGE_SEARCH_INDEX,
    using: `gin (${KNOWLEDGE_SEARCH_INDEX_COLUMNS})`,
    replaces: "workspace_knowledge_chunks_search_idx",
  },
  {
    name: KNOWLEDGE_UNIT_INDEX,
    using: `btree (${KNOWLEDGE_UNIT_INDEX_COLUMNS})`,
    replaces: "workspace_knowledge_chunks_org_id_idx",
  },
]

/**
 * Builds each index of `INDEXES` CONCURRENTLY, then drops the one that it replaces CONCURRENTLY. Neither blocks a read
 * or a write of the chunks. A concurrent build cannot run in a transaction, so this runs after Drizzle's migrations,
 * which run in one, on a connection of its own in autocommit, which it closes after:
 *
 * - **Idempotent:** with a valid index there, it only drops the old one (if it is still there).
 * - **A failed build** leaves an invalid index; the next run drops it and builds again.
 * - **Old transactions:** a concurrent build waits for every transaction that may still see the table, so its lock
 *   wait is ten minutes, not migrate's 30 seconds. A build that waits longer is a warning: migrate goes on, the old
 *   index stays, and the next migrate builds the new one. The search works with either.
 */
export async function buildKnowledgeIndexes(
  connectionString: string,
): Promise<void> {
  const client = new pg.Client({ connectionString })
  await client.connect()
  try {
    await client.query("SET lock_timeout = '10min'")
    for (const index of INDEXES) {
      try {
        const found = await client.query<{ valid: boolean }>(
          `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
           WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace`,
          [index.name],
        )
        if (found.rows[0]?.valid !== true) {
          await client.query(
            `DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`,
          )
          const started = performance.now()
          await client.query(
            `CREATE INDEX CONCURRENTLY "${index.name}" ON "workspace_knowledge_chunks" USING ${index.using}`,
          )
          const chunks = await client.query<{ n: string }>(
            "SELECT count(*) AS n FROM workspace_knowledge_chunks",
          )
          log.info({
            step: "migrate",
            message: "[migrate] built an index of the knowledge chunks",
            index: index.name,
            chunks: Number(chunks.rows[0]?.n ?? 0),
            seconds: Math.round((performance.now() - started) / 1000),
          })
        }
        await client.query(
          `DROP INDEX CONCURRENTLY IF EXISTS "${index.replaces}"`,
        )
      } catch (error) {
        if ((error as { code?: string }).code !== "55P03") throw error
        log.warn({
          step: "migrate",
          message:
            "[migrate] an index of the knowledge chunks was not built: older transactions held the table for 10 minutes. The next migrate builds it.",
          index: index.name,
        })
      }
    }
  } finally {
    await client.end()
  }
}
