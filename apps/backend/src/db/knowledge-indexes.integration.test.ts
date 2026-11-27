import pg from "pg"
import { afterAll, beforeAll, expect, it } from "vitest"

import { buildKnowledgeIndexes } from "./knowledge-indexes.js"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"
import {
  KNOWLEDGE_SEARCH_INDEX,
  KNOWLEDGE_UNIT_INDEX,
  KNOWLEDGE_VECTOR_INDEX,
} from "./schema/workspaces.js"

let pool: pg.Pool
const ownerUrl = () => ownerUrlForMigrate(process.env.DATABASE_URL ?? "")

/** The search, embedding and org indexes of the chunks, by name, with their validity and definition. */
const indexes = async () =>
  (
    await pool.query<{ name: string; valid: boolean; definition: string }>(
      `SELECT c.relname AS name, i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = 'workspace_knowledge_chunks'::regclass
         AND (c.relname LIKE '%embedding%' OR c.relname LIKE '%search%' OR c.relname LIKE '%org%')
       ORDER BY c.relname`,
    )
  ).rows

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  pool = new pg.Pool({ connectionString: ownerUrl() })
})

afterAll(async () => {
  // Leave the indexes as migrate leaves them.
  await buildKnowledgeIndexes(ownerUrl())
  await pool.end()
})

it("migrate leaves the half-precision HNSW index, the GIN index by org and Workspace and the btree index by org, Workspace and unit, and not the ones that they replace", async () => {
  const found = await indexes()
  expect(found.map(({ name, valid }) => ({ name, valid }))).toEqual([
    { name: KNOWLEDGE_VECTOR_INDEX, valid: true },
    { name: KNOWLEDGE_UNIT_INDEX, valid: true },
    { name: KNOWLEDGE_SEARCH_INDEX, valid: true },
  ])
  const definition = (name: string) =>
    found.find((index) => index.name === name)?.definition
  expect(definition(KNOWLEDGE_VECTOR_INDEX)).toMatch(
    /USING hnsw \(\(\(?embedding\)?::halfvec\(2000\)\) halfvec_cosine_ops\)/,
  )
  expect(definition(KNOWLEDGE_SEARCH_INDEX)).toMatch(
    /USING gin \(\(?org_id\)? COLLATE "C", \(?workspace_id\)? COLLATE "C", search\)/,
  )
  expect(definition(KNOWLEDGE_UNIT_INDEX)).toMatch(
    /USING btree \(org_id, workspace_id, unit_id\)/,
  )
})

it("builds a missing index again, and changes nothing when all are there", async () => {
  await pool.query(`DROP INDEX CONCURRENTLY "${KNOWLEDGE_SEARCH_INDEX}"`)
  await buildKnowledgeIndexes(ownerUrl())
  const rebuilt = await indexes()
  expect(rebuilt.map(({ name, valid }) => ({ name, valid }))).toEqual([
    { name: KNOWLEDGE_VECTOR_INDEX, valid: true },
    { name: KNOWLEDGE_UNIT_INDEX, valid: true },
    { name: KNOWLEDGE_SEARCH_INDEX, valid: true },
  ])
  await buildKnowledgeIndexes(ownerUrl())
  expect(await indexes()).toEqual(rebuilt)
}, 300_000)
