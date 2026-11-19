import pg from "pg"
import { afterAll, beforeAll, expect, it } from "vitest"

import { buildKnowledgeVectorIndex } from "./knowledge-vector-index.js"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"
import { KNOWLEDGE_VECTOR_INDEX } from "./schema/workspaces.js"

let pool: pg.Pool

const indexes = async () =>
  (
    await pool.query<{ name: string; valid: boolean; definition: string }>(
      `SELECT c.relname AS name, i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = 'workspace_knowledge_chunks'::regclass AND c.relname LIKE '%embedding%'`,
    )
  ).rows

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  pool = new pg.Pool({
    connectionString: ownerUrlForMigrate(process.env.DATABASE_URL),
  })
})

afterAll(async () => {
  // Leave the index as migrate leaves it.
  await buildKnowledgeVectorIndex(
    ownerUrlForMigrate(process.env.DATABASE_URL ?? ""),
  )
  await pool.end()
})

it("migrate leaves one valid half-precision HNSW index of the embeddings, and the full-precision one gone", async () => {
  const found = await indexes()
  expect(found.map(({ name, valid }) => ({ name, valid }))).toEqual([
    { name: KNOWLEDGE_VECTOR_INDEX, valid: true },
  ])
  expect(found[0]?.definition).toMatch(
    /USING hnsw \(\(\(?embedding\)?::halfvec\(2000\)\) halfvec_cosine_ops\)/,
  )
})

it("builds the index again when it is missing, and changes nothing when it is there", async () => {
  await pool.query(`DROP INDEX CONCURRENTLY "${KNOWLEDGE_VECTOR_INDEX}"`)
  await buildKnowledgeVectorIndex(
    ownerUrlForMigrate(process.env.DATABASE_URL ?? ""),
  )
  const rebuilt = await indexes()
  expect(rebuilt.map(({ name, valid }) => ({ name, valid }))).toEqual([
    { name: KNOWLEDGE_VECTOR_INDEX, valid: true },
  ])
  await buildKnowledgeVectorIndex(
    ownerUrlForMigrate(process.env.DATABASE_URL ?? ""),
  )
  expect(await indexes()).toEqual(rebuilt)
}, 300_000)
