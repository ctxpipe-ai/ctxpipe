import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ClickHouseClient } from "@clickhouse/client"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import {
  knowledgeRowCounts,
  startClickHouse,
  userUrl as databaseUserUrl,
} from "../test/clickhouse.js"
import {
  createClickHouseClient,
  createKnowledgeStore,
  type DocumentRows,
  type KnowledgeReadScope,
  type KnowledgeScope,
  KNOWLEDGE_TABLES,
  type KnowledgeStore,
  NO_KNOWLEDGE_ROWS,
  ORG_SETTING,
  type PurgeScope,
  type TreeEntry,
} from "./knowledge-store.js"
import { migrateKnowledgeStore } from "./migrate.js"

/*
 * The two org walls of ADR-066 decision 9, and the writes of file versions
 * and trees of ADR-071, against a real ClickHouse of the pinned image. Each
 * test that removes a wall uses its own database, so that the other tests
 * keep both walls.
 *
 * Read walls: (1) the WHERE clause of KnowledgeStore, (2) the row policy.
 * Insert walls: (1) KnowledgeStore sets the org columns, (2) the CHECK
 * constraint. Each wall is proved alone.
 */

const tables = [
  "documents",
  "chunks",
  "relations",
  "relations_in",
  "doc_refs",
  "trees",
] as const
const orgA: KnowledgeScope = { orgId: "org_wall_a", workspaceId: "ws_same" }
// The same Workspace id in both orgs: only the org can separate the rows.
const orgB: KnowledgeScope = { orgId: "org_wall_b", workspaceId: "ws_same" }

let clickHouse: Awaited<ReturnType<typeof startClickHouse>>
let serverUrl: string
const freshDatabase = () => clickHouse.freshDatabase()
/** A quiet client: several statements here fail on purpose. */
const rawClient = (url: string) => clickHouse.client(url)

async function rawRows<T>(
  client: ClickHouseClient,
  query: string,
  orgId?: string,
): Promise<T[]> {
  const result = await client.query({
    query,
    format: "JSONEachRow",
    clickhouse_settings: orgId ? { [ORG_SETTING]: orgId } : {},
  })
  return result.json<T>()
}

const observedAt = new Date("2026-11-19T10:11:12.345Z")
/** The source's own time of a file version (CTX-1516). */
const SOURCE_TIME = new Date("2019-01-18T00:00:00.000Z")
const denied = /ACCESS_DENIED|Not enough privileges/

function rowsOf(
  title: string,
  docKey = "shared.md",
  dstDoc = "target.md",
): DocumentRows {
  return {
    document: {
      docKey,
      kind: "note",
      title,
      path: `notes/${docKey}`,
      sourceType: "git",
      source: "workspace",
      summary: `${title} summary`,
      mime: "",
      validFrom: null,
      validTo: null,
      observedAt,
    },
    chunks: [
      {
        ordinal: 0,
        text: `${title} first section`,
        startLine: 3,
        endLine: 5,
        embedding: [1, -1, 0.5],
      },
      {
        ordinal: 1,
        text: `${title} second section`,
        startLine: 7,
        endLine: 9,
        embedding: [-2, 2, 0],
      },
    ],
    relations: [
      {
        srcChunk: 1,
        predicate: "REFERENCES",
        dstDoc,
        confidence: 0.75,
        validFrom: null,
        validFromIntroduced: false,
        validTo: null,
        source: "link",
        altText: "",
        observedAt,
      },
    ],
    refKeys: [`key:${docKey}`],
  }
}

/** The tree row of the file version `version` of `rows`. */
const entryOf = (rows: DocumentRows, version: string): TreeEntry => ({
  docKey: rows.document.docKey,
  version,
  path: rows.document.path,
  status: "active",
  kind: rows.document.kind,
  observedAt: rows.document.observedAt,
  validFrom: new Date("2026-01-01T00:00:00.000Z"),
  validTo: rows.document.validTo,
  deletedAt: null,
})

/**
 * Writes the file version `version` of each of `documents` and its tree row
 * of `branch` with the tree version `treeVersion`.
 */
async function put(
  store: KnowledgeStore,
  scope: KnowledgeScope,
  documents: DocumentRows[],
  { version = "v1", treeVersion = 1, branch = "main" } = {},
): Promise<void> {
  await store.writeFileVersions(
    scope,
    documents.map((rows) => ({ ...rows, version })),
  )
  await store.writeTree(
    scope,
    branch,
    treeVersion,
    documents.map((rows) => entryOf(rows, version)),
  )
}

/** The read scope of `scope` at the head `treeVersion` of `main`. */
const at = (scope: KnowledgeScope, treeVersion = 1): KnowledgeReadScope => ({
  orgId: scope.orgId,
  heads: [{ workspaceId: scope.workspaceId, branch: "main", treeVersion }],
})

/**
 * The document of `docKey` in the view of `scope`, with its chunks in order
 * and its relations in both directions, or null.
 */
async function readOne(
  store: KnowledgeStore,
  scope: KnowledgeReadScope,
  docKey: string,
) {
  const workspaceId = scope.heads[0]?.workspaceId ?? ""
  const ref = { workspaceId, docKey }
  const [found] = await store.readDocuments(scope, [ref])
  if (!found) return null
  const [evidence] = await store.readEvidence(scope, [ref], [1, 0, 0], 100)
  const relations = await store.readFrontier(scope, [ref])
  return {
    document: found.document,
    chunks: [...(evidence?.chunks ?? [])]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map(({ distance: _distance, ...chunk }) => chunk),
    outgoing: relations
      .filter((row) => row.direction === "out")
      .map((row) => row.relation),
    incoming: relations
      .filter((row) => row.direction === "in")
      .map((row) => row.relation),
  }
}

/** The document as a read gives it: active, with the tree's `valid_from`. */
const active = (rows: DocumentRows) => ({
  ...rows.document,
  status: "active",
  deletedAt: null,
  error: "",
  validFrom: new Date("2026-01-01T00:00:00.000Z"),
})

/** A chunk as a read gives it: no vector. */
const chunkLines = (rows: DocumentRows) =>
  rows.chunks.map(({ embedding: _embedding, ...chunk }) => chunk)

/** A relation as a read gives it. */
const relationOf = (rows: DocumentRows) =>
  rows.relations.map(({ validFromIntroduced: _flag, ...relation }) => ({
    ...relation,
    srcDoc: rows.document.docKey,
  }))

beforeAll(async () => {
  clickHouse = await startClickHouse()
  serverUrl = clickHouse.serverUrl
}, 240_000)

afterAll(async () => {
  await clickHouse?.stop()
})

describe("KnowledgeStore", () => {
  it("fails closed when CLICKHOUSE_URL is not set", () => {
    expect(() => createKnowledgeStore(undefined)).toThrow(/CLICKHOUSE_URL/)
    expect(() => createKnowledgeStore("")).toThrow(/CLICKHOUSE_URL/)
  })

  it("refuses a statement without an org or a Workspace", async () => {
    const store = createKnowledgeStore(serverUrl)
    try {
      const noWorkspace = { orgId: "org", workspaceId: "" }
      const noOrg = { orgId: "", workspaceId: "ws" }
      const head = { branch: "main", treeVersion: 1 }
      for (const statement of [
        store.writeFileVersions(noWorkspace, [
          { ...rowsOf("x"), version: "v1" },
        ]),
        store.writeTree(noWorkspace, "main", 1, [entryOf(rowsOf("x"), "v1")]),
        store.deleteTreeAbove(noWorkspace, "main", 0),
        store.cleanUp(noOrg, {
          heads: [head],
          replacedBefore: observedAt,
          unusedBefore: observedAt,
        }),
        store.findFileVersions(noOrg, [{ docKey: "x.md", version: "v1" }]),
        store.readTree(noOrg, head),
      ])
        await expect(statement).rejects.toThrow(/org and a Workspace/)
    } finally {
      await store.close()
    }
  })

  it("applies each migration one time", async () => {
    const url = await freshDatabase()
    await migrateKnowledgeStore(url)
    const applied = await rawRows<{ name: string }>(
      rawClient(url),
      "SELECT name FROM knowledge_schema_migrations",
    )
    expect(applied.map((row) => row.name).sort()).toEqual([
      "0001_knowledge_tables.sql",
      "0002_relations_in.sql",
      "0003_chunks_index_granularity.sql",
      "0004_chunk_lines.sql",
      "0005_doc_refs.sql",
      "0006_images_in_git.sql",
      "0007_cold_parts_by_age.sql",
      "0008_chunk_embedding_key.sql",
      "0009_image_texts.sql",
      "0010_file_versions_and_trees.sql",
      "0011_tree_overlays.sql",
      "0012_document_source_time.sql",
    ])
  })

  it("reads back the document, its chunks and its relations in both directions", async () => {
    const store = createKnowledgeStore(await freshDatabase())
    try {
      const source = rowsOf("Source", "source.md", "target.md")
      const target = rowsOf("Target", "target.md", "other.md")
      await put(store, orgA, [source, target])

      expect(await readOne(store, at(orgA), "missing.md")).toBeNull()
      const stored = await readOne(store, at(orgA), "target.md")
      expect(stored?.document).toEqual(active(target))
      expect(stored?.chunks).toEqual(chunkLines(target))
      expect(stored?.outgoing).toEqual(relationOf(target))
      // relations_in, sorted by dst_doc, gives the incoming relations.
      expect(stored?.incoming).toEqual(relationOf(source))
    } finally {
      await store.close()
    }
  })

  it("stores the binary form of each vector: one bit for each dimension above 0", async () => {
    const url = await freshDatabase()
    const store = createKnowledgeStore(url)
    try {
      const rows = rowsOf("Bits", "bits.md")
      rows.chunks = [
        {
          ordinal: 0,
          text: "bits",
          startLine: 1,
          endLine: 1,
          embedding: [1, -1, 1, -1, 0, 0, 0, 0.5, -2, 2, 2, 2, 2, 2, 2, 2, 3],
        },
      ]
      await put(store, orgA, [rows])
    } finally {
      await store.close()
    }
    const [chunk] = await rawRows<{ bits: string; distance: number }>(
      rawClient(url),
      `SELECT hex(embedding_bits) AS bits,
         bitHammingDistance(embedding_bits, unhex('A07F00')) AS distance
       FROM chunks`,
      orgA.orgId,
    )
    expect(chunk).toEqual({ bits: "A17F80", distance: 2 })
  })
})

describe("readEmbeddings (CTX-1428)", () => {
  /** One document of one chunk with `vector` under `key`. */
  const keyed = (docKey: string, key: string, vector: number[]) => {
    const rows = rowsOf(docKey, docKey)
    rows.chunks = [
      {
        ordinal: 0,
        text: docKey,
        startLine: 1,
        endLine: 1,
        embedding: vector,
        embeddingKey: key,
      },
    ]
    return rows
  }

  it("reads the vector of a key only in the documents, the Workspace and the org of the scope, of any file version", async () => {
    const store = createKnowledgeStore(await freshDatabase())
    const otherWorkspace = { ...orgA, workspaceId: "ws_other" }
    try {
      await put(store, orgA, [
        keyed("shared.md", "k1", [1, -1, 0.5]),
        keyed("other.md", "k2", [0.5, 0.5, 0.5]),
      ])
      // An older file version of shared.md, with no tree row.
      await store.writeFileVersions(orgA, [
        { ...keyed("shared.md", "k3", [3, 3, 3]), version: "v0" },
      ])
      await put(store, orgB, [keyed("shared.md", "k1", [-2, 2, 0])])
      await put(store, otherWorkspace, [keyed("shared.md", "k1", [4, 4, 4])])
      const read = async (scope: KnowledgeScope, docKeys: string[]) =>
        Object.fromEntries(
          await store.readEmbeddings(scope, docKeys, ["k1", "k2", "k3", ""]),
        )
      expect(await read(orgA, ["shared.md"])).toEqual({
        k1: [1, -1, 0.5],
        k3: [3, 3, 3],
      })
      expect(await read(orgA, ["other.md"])).toEqual({ k2: [0.5, 0.5, 0.5] })
      expect(await read(orgB, ["shared.md", "other.md"])).toEqual({
        k1: [-2, 2, 0],
      })
      expect(await read(otherWorkspace, ["shared.md"])).toEqual({
        k1: [4, 4, 4],
      })
      expect(await read(orgA, [])).toEqual({})
    } finally {
      await store.close()
    }
  })

  it("gives the stored BFloat16 value, and a write of it stores the same value", async () => {
    const url = await freshDatabase()
    const store = createKnowledgeStore(url)
    try {
      const vector = [0.1, -1 / 3, 1234.5678, 1e-7]
      await put(store, orgA, [keyed("first.md", "k", vector)])
      const stored = (
        await store.readEmbeddings(orgA, ["first.md"], ["k"])
      ).get("k")
      expect(stored).toHaveLength(vector.length)
      expect(stored).not.toEqual(vector)
      await put(store, orgA, [keyed("second.md", "k", stored ?? [])])
      const vectors = await rawRows<{ docKey: string; embedding: number[] }>(
        rawClient(url),
        "SELECT doc_key AS docKey, embedding FROM chunks ORDER BY doc_key",
        orgA.orgId,
      )
      expect(vectors).toEqual([
        { docKey: "first.md", embedding: stored },
        { docKey: "second.md", embedding: stored },
      ])
    } finally {
      await store.close()
    }
  })
})

describe("image_texts (CTX-1433)", () => {
  const row = (blobSha: string, model: string, reading: string) => ({
    blobSha,
    model,
    promptVersion: 1,
    reading,
  })

  it("reads a reading only in the Workspace and the org of the scope, for the prompt version", async () => {
    const store = createKnowledgeStore(await freshDatabase())
    const otherWorkspace = { ...orgA, workspaceId: "ws_other" }
    try {
      await store.writeImageTexts(orgA, [row("sha1", "m/a", "a1")])
      await store.writeImageTexts(orgB, [row("sha1", "m/a", "b1")])
      await store.writeImageTexts(otherWorkspace, [
        { ...row("sha1", "m/a", "w1"), promptVersion: 2 },
      ])
      const read = async (scope: KnowledgeScope, version = 1) =>
        Object.fromEntries(
          [
            ...(await store.readImageTexts(
              scope,
              ["sha1", "sha2"],
              "m/a",
              version,
            )),
          ].map(([sha, text]) => [sha, text.reading]),
        )
      expect(await read(orgA)).toEqual({ sha1: "a1" })
      expect(await read(orgB)).toEqual({ sha1: "b1" })
      expect(await read(otherWorkspace)).toEqual({})
      expect(await read(otherWorkspace, 2)).toEqual({ sha1: "w1" })
    } finally {
      await store.close()
    }
  })

  it("gives the reading of the model only, and one row for a key written twice", async () => {
    const store = createKnowledgeStore(await freshDatabase())
    try {
      await store.writeImageTexts(orgA, [
        row("sha1", "m/old", "from the old model"),
        row("sha2", "m/old", "only the old model"),
      ])
      await store.writeImageTexts(orgA, [row("sha1", "m/new", "new")])
      await store.writeImageTexts(orgA, [row("sha1", "m/new", "new")])
      const texts = await store.readImageTexts(
        orgA,
        ["sha1", "sha2"],
        "m/new",
        1,
      )
      expect(Object.fromEntries(texts)).toEqual({
        sha1: row("sha1", "m/new", "new"),
      })
      expect(
        (await store.readImageTexts(orgA, ["sha1"], "m/other", 1)).size,
      ).toBe(0)
    } finally {
      await store.close()
    }
  })
})

describe("org isolation of reads", () => {
  let url: string

  beforeAll(async () => {
    url = await freshDatabase()
    const store = createKnowledgeStore(url)
    try {
      await put(store, orgA, [rowsOf("Org A")])
      await put(store, orgB, [rowsOf("Org B")])
    } finally {
      await store.close()
    }
  })

  it("both walls: KnowledgeStore returns only the rows of the org of the scope", async () => {
    const store = createKnowledgeStore(url)
    try {
      const forB = await readOne(store, at(orgB), "shared.md")
      expect(forB?.document.title).toBe("Org B")
      expect(forB?.chunks.map((chunk) => chunk.text)).toEqual([
        "Org B first section",
        "Org B second section",
      ])
      expect(forB?.outgoing).toHaveLength(1)
      const forA = await readOne(store, at(orgA), "shared.md")
      expect(forA?.document.title).toBe("Org A")
      expect(
        (await store.readTree(orgB, { branch: "main", treeVersion: 1 })).map(
          (entry) => entry.docKey,
        ),
      ).toEqual(["shared.md"])
    } finally {
      await store.close()
    }
  })

  it("row policy alone: a statement for org B without the org in its WHERE clause gets no row of org A", async () => {
    const client = rawClient(url)
    for (const table of tables) {
      const rows = await rawRows<{ org_id: string }>(
        client,
        `SELECT org_id FROM ${table}`,
        orgB.orgId,
      )
      expect(rows.length, table).toBeGreaterThan(0)
      expect(new Set(rows.map((row) => row.org_id)), table).toEqual(
        new Set([orgB.orgId]),
      )
    }
    // The read of the incoming relations.
    const incoming = await rawRows<{ org_id: string }>(
      client,
      "SELECT org_id FROM relations_in WHERE dst_doc = 'target.md'",
      orgB.orgId,
    )
    expect(incoming).toEqual([{ org_id: orgB.orgId }])
  })

  it("row policy alone: a statement with no org setting fails", async () => {
    for (const table of tables)
      await expect(
        rawRows(rawClient(url), `SELECT org_id FROM ${table}`),
      ).rejects.toThrow(new RegExp(ORG_SETTING))
  })

  it("WHERE clause alone: with the row policies removed, KnowledgeStore returns no row of org A for org B", async () => {
    const policyFree = await freshDatabase()
    const client = rawClient(policyFree)
    for (const table of tables)
      await client.command({
        query: `DROP ROW POLICY knowledge_org_wall ON ${table}`,
      })
    const store = createKnowledgeStore(policyFree)
    try {
      await put(store, orgA, [
        rowsOf("Org A", "shared.md"),
        rowsOf("Org A source", "a.md"),
      ])
      await put(store, orgB, [
        rowsOf("Org B", "shared.md"),
        rowsOf("Org B target", "target.md", "other.md"),
      ])
      // Without the policy, a statement for org B sees both orgs.
      const all = await rawRows<{ org_id: string }>(
        client,
        "SELECT DISTINCT org_id FROM documents ORDER BY org_id",
        orgB.orgId,
      )
      expect(all.map((row) => row.org_id)).toEqual([orgA.orgId, orgB.orgId])

      const forB = await readOne(store, at(orgB), "shared.md")
      expect(forB?.document.title).toBe("Org B")
      expect(forB?.chunks.map((chunk) => chunk.text)).toEqual([
        "Org B first section",
        "Org B second section",
      ])
      expect(forB?.outgoing.map((relation) => relation.dstDoc)).toEqual([
        "target.md",
      ])
      expect(await readOne(store, at(orgB), "a.md")).toBeNull()
      // Org A's shared.md and a.md also point at target.md.
      const target = await readOne(store, at(orgB), "target.md")
      expect(target?.document.title).toBe("Org B target")
      expect(target?.incoming.map((relation) => relation.srcDoc)).toEqual([
        "shared.md",
      ])
      // The same file version key in two orgs: the tree of org B joins only
      // the file versions of org B.
      expect(
        (
          await store.findFileVersions(orgB, [
            { docKey: "a.md", version: "v1" },
          ])
        ).size,
      ).toBe(0)
    } finally {
      await store.close()
    }
  })
})

describe("org isolation of inserts", () => {
  it("CHECK constraint alone: a raw insert of org B rows in a session for org A fails", async () => {
    const url = await freshDatabase()
    const client = rawClient(url)
    const relationRow = {
      src_doc: "x.md",
      src_version: "v1",
      src_chunk: 0,
      predicate: "REFERENCES",
      dst_doc: "y.md",
      confidence: 1,
      observed_at: "2026-11-19 10:11:12.345",
    }
    const rows = {
      documents: {
        doc_key: "x.md",
        version: "v1",
        kind: "note",
        status: "active",
        observed_at: "2026-11-19 10:11:12.345",
      },
      chunks: {
        doc_key: "x.md",
        version: "v1",
        ordinal: 0,
        text: "x",
        embedding: [1],
      },
      relations: relationRow,
      relations_in: relationRow,
      doc_refs: { ref_key: "key:x.md", doc_key: "x.md", version: "v1" },
      trees: {
        branch: "main",
        doc_key: "x.md",
        tree_version: 1,
        kind: "file",
        path: "x.md",
        version: "v1",
        status: "active",
        observed_at: "2026-11-19 10:11:12.345",
      },
    }
    for (const table of tables) {
      await expect(
        client.insert({
          table,
          values: [{ ...rows[table], org_id: orgB.orgId, workspace_id: "ws" }],
          format: "JSONEachRow",
          clickhouse_settings: {
            [ORG_SETTING]: orgA.orgId,
            wait_for_async_insert: 1,
          },
        }),
        table,
      ).rejects.toThrow(/org_wall/)
      // No org setting: the constraint cannot pass either.
      await expect(
        client.insert({
          table,
          values: [{ ...rows[table], org_id: orgB.orgId, workspace_id: "ws" }],
          format: "JSONEachRow",
          clickhouse_settings: { wait_for_async_insert: 1 },
        }),
        table,
      ).rejects.toThrow(new RegExp(ORG_SETTING))
      const stored = await rawRows(
        client,
        `SELECT org_id FROM ${table}`,
        orgB.orgId,
      )
      expect(stored, table).toEqual([])
    }
  })

  it("KnowledgeStore alone: with the constraints removed, an insert for org A stores no org B row, because KnowledgeStore sets the org columns itself", async () => {
    const url = await freshDatabase()
    const client = rawClient(url)
    for (const table of tables)
      await client.command({
        query: `ALTER TABLE ${table} DROP CONSTRAINT org_wall`,
      })
    const rows = rowsOf("Smuggled")
    // A caller that bypasses the types and puts the org columns in each row.
    const smuggle = { org_id: orgB.orgId, workspace_id: "ws_other" }
    Object.assign(rows.document, smuggle)
    for (const chunk of rows.chunks) Object.assign(chunk, smuggle)
    for (const relation of rows.relations) Object.assign(relation, smuggle)
    const store = createKnowledgeStore(url)
    try {
      await store.writeFileVersions(orgA, [{ ...rows, version: "v1" }])
      await store.writeTree(orgA, "main", 1, [
        { ...entryOf(rows, "v1"), ...smuggle },
      ])
      expect(await readOne(store, at(orgB), "shared.md")).toBeNull()
      expect(
        (await readOne(store, at(orgA), "shared.md"))?.chunks,
      ).toHaveLength(2)
    } finally {
      await store.close()
    }
    for (const table of tables) {
      const forB = await rawRows(
        client,
        `SELECT org_id FROM ${table}`,
        orgB.orgId,
      )
      expect(forB, table).toEqual([])
      const forA = await rawRows<{ org_id: string; workspace_id: string }>(
        client,
        `SELECT DISTINCT org_id, workspace_id FROM ${table}`,
        orgA.orgId,
      )
      expect(forA, table).toEqual([
        { org_id: orgA.orgId, workspace_id: orgA.workspaceId },
      ])
    }
  })
})

describe("known gap: a change in a patch part can stay hidden from reads", () => {
  // ADR-066 decision 8 and CTX-1401: on the pinned image, a DELETE with
  // lightweight_delete_mode = 'lightweight_update' and a lightweight UPDATE
  // write patch parts. When the changed rows are in a part that a merge made,
  // a read that moves a filter to PREWHERE (the default) still returns the old
  // rows, until a later merge. ClickHouse PR #112947 describes this. Thus
  // KnowledgeStore uses only the classic lightweight DELETE and INSERT; the
  // tests above read after each such DELETE. This test fails when a
  // ClickHouse version fixes the gap, so that the ADR can change back to
  // patch parts.
  it.each([
    [
      "DELETE in lightweight_update mode",
      "DELETE FROM patched WHERE ws = 'w3' AND src = 'doc'",
    ],
    [
      "lightweight UPDATE",
      "UPDATE patched SET status = 'deleted' WHERE ws = 'w3' AND src = 'doc'",
    ],
  ])("%s", async (name, change) => {
    const client = rawClient(await freshDatabase())
    const run = (query: string) =>
      client.command({
        query,
        clickhouse_settings: { lightweight_delete_mode: "lightweight_update" },
      })
    await run(`CREATE TABLE patched
      (ws String, src String, status String DEFAULT 'active')
      ENGINE = MergeTree ORDER BY (ws, src)
      SETTINGS enable_block_number_column = 1, enable_block_offset_column = 1`)
    // Merges only where this test starts them, so that the parts are the
    // same in each run.
    await run("SYSTEM STOP MERGES patched")
    for (const round of [1, 2, 3]) {
      await run(
        `INSERT INTO patched (ws, src) VALUES ('w${round}', 'doc'), ('w${round}', 't')`,
      )
      await run(`INSERT INTO patched (ws, src) VALUES ('x${round}', 'doc')`)
      if (round === 3) {
        await run("SYSTEM START MERGES patched")
        await run("OPTIMIZE TABLE patched")
        await run("SYSTEM STOP MERGES patched")
      }
      await run(change.replaceAll("w3", `w${round}`))
    }
    const visible = async (prewhere: 0 | 1) =>
      (
        await rawRows<{ rows: number }>(
          client,
          `SELECT count() AS rows FROM patched
           WHERE ws = 'w3' AND src = 'doc' AND status = 'active'
           SETTINGS optimize_move_to_prewhere = ${prewhere}`,
        )
      )[0]?.rows
    // Without PREWHERE, each change is visible.
    expect(await visible(0), name).toBe(0)
    // With PREWHERE, the read still returns the old row.
    expect(await visible(1), name).toBe(1)
  })
})

describe("known gap: the row policy does not filter changes", () => {
  // ADR-066 decision 9 and the review of CTX-1392: a ClickHouse row policy
  // filters reads only. A lightweight DELETE or UPDATE has one wall, the org
  // and the Workspace in its WHERE clause. This test fails when ClickHouse
  // starts to apply the policy to changes, so that the ADR can change.
  it("a DELETE for org A without the org in its WHERE clause deletes rows of org B", async () => {
    const url = await freshDatabase()
    const store = createKnowledgeStore(url)
    try {
      await put(store, orgA, [rowsOf("Org A")])
      await put(store, orgB, [rowsOf("Org B")])
      await rawClient(url).command({
        query: "DELETE FROM trees WHERE doc_key = 'shared.md'",
        clickhouse_settings: { [ORG_SETTING]: orgA.orgId },
      })
      expect(await readOne(store, at(orgB), "shared.md")).toBeNull()
    } finally {
      await store.close()
    }
  })
})

/*
 * The users that the migration makes (ADR-066 decision 9), the writes of
 * file versions and trees, and the cleanup (ADR-071). The writes run as the
 * writer user of the worker, and the reads as the reader user of the
 * backend. The users are global to the server, so these tests share one
 * database.
 */
describe("users and mutations", () => {
  const passwords = { reader: "reader-test", writer: "writer-test" }
  let adminUrl: string
  let readerUrl: string
  let writerUrl: string
  let reader: ReturnType<typeof createKnowledgeStore>
  let writer: ReturnType<typeof createKnowledgeStore>

  const userUrl = (user: string, password: string) =>
    databaseUserUrl(adminUrl, user, password)

  /** All rows of a scope in each table, as the admin user reads them. */
  async function snapshot(scope: KnowledgeScope) {
    const client = rawClient(adminUrl)
    const result: Record<string, unknown[]> = {}
    for (const table of tables)
      result[table] = await rawRows(
        client,
        `SELECT * EXCEPT (org_id, workspace_id, written_at) FROM ${table}
         WHERE org_id = '${scope.orgId}' AND workspace_id = '${scope.workspaceId}'
         ORDER BY ALL`,
        scope.orgId,
      )
    return result
  }

  /** relations and relations_in hold the same rows for the scope. */
  async function expectSameRelations(scope: KnowledgeScope) {
    const rows = await snapshot(scope)
    expect(rows.relations_in).toEqual(rows.relations)
  }

  /** The count of rows of each table of a scope. */
  async function counts(scope: KnowledgeScope) {
    const rows = await snapshot(scope)
    return Object.fromEntries(
      Object.entries(rows).map(([table, list]) => [table, list.length]),
    )
  }

  beforeAll(async () => {
    adminUrl = await freshDatabase()
    await migrateKnowledgeStore(adminUrl, passwords)
    readerUrl = userUrl("ctxpipe_reader", passwords.reader)
    writerUrl = userUrl("ctxpipe_writer", passwords.writer)
    reader = createKnowledgeStore(readerUrl)
    writer = createKnowledgeStore(writerUrl)
  })

  afterAll(async () => {
    await reader?.close()
    await writer?.close()
  })

  it("the reader user can read, and cannot insert, update or delete", async () => {
    const scope = { orgId: "org_users", workspaceId: "ws_reader" }
    await put(writer, scope, [rowsOf("Reader", "r.md")])
    expect((await readOne(reader, at(scope), "r.md"))?.document.title).toBe(
      "Reader",
    )
    expect(await reader.listDocumentStatuses(at(scope))).toEqual([
      { docKey: "r.md", status: "active" },
      { docKey: "target.md", status: "missing" },
    ])

    await expect(
      reader.writeFileVersions(scope, [
        { ...rowsOf("Changed", "r.md"), version: "v2" },
      ]),
    ).rejects.toThrow(denied)
    await expect(
      reader.writeTree(scope, "main", 2, [
        { ...entryOf(rowsOf("Changed", "r.md"), "v1"), deletedAt: observedAt },
      ]),
    ).rejects.toThrow(denied)
    await expect(reader.deleteTreeAbove(scope, "main", 0)).rejects.toThrow(
      denied,
    )
    const client = rawClient(readerUrl)
    const settings = { [ORG_SETTING]: scope.orgId }
    for (const table of tables) {
      await expect(
        client.insert({
          table,
          values: [{ org_id: scope.orgId, workspace_id: scope.workspaceId }],
          format: "JSONEachRow",
          clickhouse_settings: { ...settings, wait_for_async_insert: 1 },
        }),
        table,
      ).rejects.toThrow(denied)
      await expect(
        client.command({
          query: `DELETE FROM ${table} WHERE org_id = '${scope.orgId}'`,
          clickhouse_settings: settings,
        }),
        table,
      ).rejects.toThrow(denied)
    }
    await expect(
      client.command({
        query: `UPDATE documents SET title = 'x' WHERE org_id = '${scope.orgId}'`,
        clickhouse_settings: settings,
      }),
    ).rejects.toThrow(denied)
    expect(await readOne(reader, at(scope), "r.md")).toMatchObject({
      document: { title: "Reader", status: "active" },
    })
  })

  it("takes the password of the user from CLICKHOUSE_PASSWORD_FILE, as Docker Compose gives it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "clickhouse-password-"))
    const file = join(directory, "password")
    writeFileSync(file, `${passwords.reader}\n`)
    const noPassword = userUrl("ctxpipe_reader", "")
    const scope = { orgId: "org_users", workspaceId: "ws_password_file" }
    const without = createKnowledgeStore(noPassword)
    vi.stubEnv("CLICKHOUSE_PASSWORD_FILE", file)
    const withFile = createKnowledgeStore(noPassword)
    try {
      await expect(without.listDocumentStatuses(at(scope))).rejects.toThrow(
        /Authentication failed/,
      )
      expect(await withFile.listDocumentStatuses(at(scope))).toEqual([])
    } finally {
      vi.unstubAllEnvs()
      await without.close()
      await withFile.close()
      rmSync(directory, { recursive: true })
    }
  })

  it("a password file may hold URL characters such as % @ : /", async () => {
    const password = "p%w@d:x/y"
    const admin = rawClient(adminUrl)
    await admin.command({
      query: `CREATE USER OR REPLACE ctxpipe_password_file IDENTIFIED WITH sha256_password BY '${password}'`,
    })
    const directory = mkdtempSync(join(tmpdir(), "clickhouse-password-"))
    const file = join(directory, "password")
    writeFileSync(file, password)
    vi.stubEnv("CLICKHOUSE_PASSWORD_FILE", file)
    const client = createClickHouseClient(userUrl("ctxpipe_password_file", ""))
    try {
      const result = await client.query({
        query: "SELECT currentUser() AS user",
        format: "JSONEachRow",
      })
      expect(await result.json()).toEqual([{ user: "ctxpipe_password_file" }])
    } finally {
      vi.unstubAllEnvs()
      await client.close()
      await admin.command({ query: "DROP USER ctxpipe_password_file" })
      rmSync(directory, { recursive: true })
    }
  })

  it("the writer user cannot manage access, drop a wall or change the migrations", async () => {
    const client = rawClient(writerUrl)
    for (const table of tables) {
      await expect(
        client.command({
          query: `DROP ROW POLICY knowledge_org_wall ON ${table}`,
        }),
        table,
      ).rejects.toThrow(denied)
      await expect(
        client.command({
          query: `ALTER TABLE ${table} DROP CONSTRAINT org_wall`,
        }),
        table,
      ).rejects.toThrow(denied)
      await expect(
        client.command({ query: `DROP TABLE ${table}` }),
        table,
      ).rejects.toThrow(denied)
    }
    for (const query of [
      "CREATE USER knowledge_intruder IDENTIFIED BY 'intruder-password'",
      "CREATE ROW POLICY open_wall ON documents AS PERMISSIVE USING 1 TO ALL",
      "GRANT SELECT ON documents TO ctxpipe_reader",
      "GRANT INSERT ON documents TO ctxpipe_reader",
      "ALTER USER ctxpipe_writer SETTINGS readonly = 0",
      // KnowledgeStore never runs an UPDATE (ADR-066 decision 8).
      "UPDATE documents SET title = 'x' WHERE org_id = 'org_m_a'",
      "UPDATE trees SET kind = 'deleted' WHERE org_id = 'org_m_a'",
      "INSERT INTO knowledge_schema_migrations (name) VALUES ('9999_x.sql')",
    ])
      await expect(client.command({ query }), query).rejects.toThrow(denied)
  })

  it("refuses a reader, writer or admin password that is the same as another", async () => {
    for (const users of [
      { reader: "knowledge-test" },
      { writer: "knowledge-test" },
      { reader: "same-password", writer: "same-password" },
    ])
      await expect(migrateKnowledgeStore(adminUrl, users)).rejects.toThrow(
        /must be different from each other/,
      )
    const publicAdmin = new URL(adminUrl)
    publicAdmin.password = "ctxpipe"
    await expect(
      migrateKnowledgeStore(publicAdmin.toString(), passwords),
    ).rejects.toThrow(/default admin password ctxpipe is public/)
  })

  // CTX-1672: the erase reads the names of the parts, and nothing more.
  it("the writer reads only the database, table and name of the parts of the knowledge tables, and the reader reads no part", async () => {
    const parts = await rawRows<{ table: string }>(
      rawClient(writerUrl),
      "SELECT DISTINCT table FROM system.parts ORDER BY table",
    )
    expect(parts.length).toBeGreaterThan(0)
    for (const { table } of parts) expect(KNOWLEDGE_TABLES).toContain(table)
    await expect(
      rawRows(rawClient(writerUrl), "SELECT rows FROM system.parts"),
    ).rejects.toThrow(denied)
    await expect(
      rawRows(rawClient(readerUrl), "SELECT name FROM system.parts"),
    ).rejects.toThrow(denied)
    await expect(
      reader.partsLeft([{ table: "documents", part: "all_1_1_0" }]),
    ).rejects.toThrow(denied)
  })

  it("a second migration sets a new password and keeps the grants", async () => {
    await migrateKnowledgeStore(adminUrl, {
      reader: "reader-rotated",
      writer: passwords.writer,
    })
    try {
      await expect(
        rawRows(rawClient(readerUrl), "SELECT 1 AS one"),
      ).rejects.toThrow(/password is incorrect/)
      const rotated = rawClient(userUrl("ctxpipe_reader", "reader-rotated"))
      await expect(
        rawRows(rotated, "SELECT count() AS rows FROM trees", "org_none"),
      ).resolves.toEqual([{ rows: 0 }])
      await expect(
        rotated.command({ query: "DELETE FROM trees WHERE 1" }),
      ).rejects.toThrow(denied)
    } finally {
      // Back to the first password for the other tests.
      await migrateKnowledgeStore(adminUrl, passwords)
    }
  })

  // CTX-1642: the deletion of an org or a Workspace deletes its rows.
  it("a purge of a Workspace, then of its org, deletes their rows from each knowledge table and keeps the rows of another Workspace and another org", async () => {
    const workspace = { orgId: "org_purge", workspaceId: "ws_purge" }
    const sibling = { orgId: "org_purge", workspaceId: "ws_purge_sibling" }
    // The same Workspace id in another org: only the org predicate keeps it.
    const otherOrg = { orgId: "org_purge_other", workspaceId: "ws_purge" }
    for (const scope of [workspace, sibling, otherOrg]) {
      await put(writer, scope, [
        rowsOf("Doc", "doc.md", "ref:key:target.md"),
        rowsOf("Target", "target.md", "doc.md"),
      ])
      await writer.writeImageTexts(scope, [
        { blobSha: "sha1", model: "m/a", promptVersion: 1, reading: "text" },
      ])
    }
    const rowsOfScope = (scope: KnowledgeScope) =>
      knowledgeRowCounts(rawClient(adminUrl), scope)
    /** The rows that the parts hold, also the rows that a DELETE hid. */
    const rowsInParts = (scope: KnowledgeScope) =>
      knowledgeRowCounts(rawClient(adminUrl), scope, { inParts: true })
    /** Erases the purged rows, and waits until the parts hold none. */
    const erase = async (scope: PurgeScope) => {
      expect(await writer.erasePurged(scope)).toBeGreaterThan(0)
      await vi.waitFor(
        async () => expect(await writer.purgedRowsInParts(scope)).toBe(0),
        { timeout: 30_000, interval: 200 },
      )
    }
    const seeded = await rowsOfScope(workspace)
    for (const table of KNOWLEDGE_TABLES)
      expect(seeded[table], table).toBeGreaterThan(0)

    // The reader user cannot purge, and a purge needs an org.
    await expect(reader.purge(workspace)).rejects.toThrow(denied)
    await expect(
      writer.purge({ orgId: "", workspaceId: null }),
    ).rejects.toThrow(/needs an org/)
    await expect(
      writer.purge({ orgId: "org_purge", workspaceId: "" }),
    ).rejects.toThrow(/needs a Workspace id/)
    expect(await rowsOfScope(workspace)).toEqual(seeded)

    expect(await writer.purge(workspace)).toEqual(seeded)
    expect(await rowsOfScope(workspace)).toEqual(NO_KNOWLEDGE_ROWS)
    expect(await rowsOfScope(sibling)).toEqual(seeded)
    expect(await rowsOfScope(otherOrg)).toEqual(seeded)
    // A purge that runs again finds nothing more.
    expect(await writer.purge(workspace)).toEqual(NO_KNOWLEDGE_ROWS)

    // CTX-1672: the DELETE only hides the rows. The parts hold them until
    // the erase rewrites the parts.
    expect(await rowsInParts(workspace)).toEqual(seeded)
    await expect(reader.erasePurged(workspace)).rejects.toThrow(denied)
    await erase(workspace)
    expect(await rowsInParts(workspace)).toEqual(NO_KNOWLEDGE_ROWS)
    expect(await rowsInParts(sibling)).toEqual(seeded)
    expect(await rowsOfScope(sibling)).toEqual(seeded)
    expect(await rowsInParts(otherOrg)).toEqual(seeded)
    // An erase with no purged rows left in the parts changes nothing.
    expect(await writer.erasePurged(workspace)).toBe(0)

    const org = { orgId: "org_purge", workspaceId: null }
    expect(await writer.purge(org)).toEqual(seeded)
    expect(await rowsOfScope(sibling)).toEqual(NO_KNOWLEDGE_ROWS)
    expect(await rowsOfScope(otherOrg)).toEqual(seeded)
    expect(await writer.purge(org)).toEqual(NO_KNOWLEDGE_ROWS)
    expect(await writer.purgedRowsInParts(org)).toBeGreaterThan(0)
    await erase(org)
    expect(await rowsInParts(sibling)).toEqual(NO_KNOWLEDGE_ROWS)
    expect(await rowsInParts(otherOrg)).toEqual(seeded)
  })

  describe("each write keeps the org and Workspace scope", () => {
    let run = 0
    let target: KnowledgeScope
    // The same keys in another Workspace of the same org, and in the same
    // Workspace id of another org.
    let others: KnowledgeScope[]
    let before: Awaited<ReturnType<typeof snapshot>>[]
    const seed = () => [
      rowsOf("Doc", "doc.md", "target.md"),
      rowsOf("Target", "target.md", "doc.md"),
    ]
    const head1 = { branch: "main", treeVersion: 1 }
    /** A cleanup with each grace time over. */
    const cleanNow = (heads = [head1], counter?: { mutations: number }) =>
      writer.cleanUp(
        target,
        {
          heads,
          replacedBefore: new Date(Date.now() + 60_000),
          unusedBefore: new Date(Date.now() + 60_000),
        },
        counter,
      )

    beforeEach(async () => {
      run += 1
      target = { orgId: "org_m_a", workspaceId: `ws_m_${run}` }
      others = [
        { orgId: "org_m_a", workspaceId: `ws_m_${run}_other` },
        { orgId: "org_m_b", workspaceId: `ws_m_${run}` },
      ]
      for (const scope of [target, ...others]) {
        await put(writer, scope, seed())
        // A second file version of doc.md at tree version 2, above the head
        // of the cleanups below. Its file states a source time (CTX-1516).
        const v2 = rowsOf("Doc v2", "doc.md", "new.md")
        await put(
          writer,
          scope,
          [{ ...v2, document: { ...v2.document, validFrom: SOURCE_TIME } }],
          { version: "v2", treeVersion: 2 },
        )
      }
      before = await Promise.all(others.map(snapshot))
    })

    // Each test changes the target scope only.
    afterEach(async () => {
      expect(await Promise.all(others.map(snapshot))).toEqual(before)
      await expectSameRelations(target)
    })

    it("finds the stored file versions, with the fields that a tree row copies", async () => {
      const found = await writer.findFileVersions(target, [
        { docKey: "doc.md", version: "v1" },
        { docKey: "doc.md", version: "v2" },
        { docKey: "doc.md", version: "v3" },
      ])
      expect([...found.keys()]).toEqual(["doc.md\0v1", "doc.md\0v2"])
      expect(found.get("doc.md\0v1")).toEqual({
        status: "active",
        kind: "note",
        observedAt,
        validFrom: null,
        validTo: null,
      })
      expect(found.get("doc.md\0v2")?.validFrom).toEqual(SOURCE_TIME)
    })

    it("a retry of a write that stopped before its document row stores each row one time", async () => {
      const next = {
        ...rowsOf("Doc v3", "doc.md"),
        version: "v3",
      }
      // The rest of a stopped write: chunks and relations, no document row.
      await writer.writeFileVersions(target, [next])
      await rawClient(adminUrl).command({
        query: `DELETE FROM documents WHERE org_id = '${target.orgId}'
          AND workspace_id = '${target.workspaceId}' AND version = 'v3'`,
        clickhouse_settings: { [ORG_SETTING]: target.orgId },
      })
      expect(
        (
          await writer.findFileVersions(target, [
            { docKey: "doc.md", version: "v3" },
          ])
        ).size,
      ).toBe(0)
      const counter = { mutations: 0 }
      await writer.writeFileVersions(target, [next], counter)
      // One DELETE for each table of the rest.
      expect(counter.mutations).toBe(5)
      const rows = await snapshot(target)
      const ofV3 = (table: string) =>
        (rows[table] as { version?: string; src_version?: string }[]).filter(
          (row) => (row.version ?? row.src_version) === "v3",
        ).length
      expect(
        Object.fromEntries(
          ["documents", "chunks", "relations", "doc_refs"].map((table) => [
            table,
            ofV3(table),
          ]),
        ),
      ).toEqual({ documents: 1, chunks: 2, relations: 1, doc_refs: 1 })
    })

    it("refuses a write with the same file version two times", async () => {
      const unchanged = await snapshot(target)
      const version = { ...rowsOf("A", "doc.md"), version: "v9" }
      await expect(
        writer.writeFileVersions(target, [version, version]),
      ).rejects.toThrow(/two times/)
      expect(await snapshot(target)).toEqual(unchanged)
    })

    it("a read takes the newest tree row at or below the head; deleteTreeAbove removes the rows above it", async () => {
      expect(
        (await readOne(reader, at(target, 1), "doc.md"))?.document.title,
      ).toBe("Doc")
      expect(
        (await readOne(reader, at(target, 2), "doc.md"))?.document.title,
      ).toBe("Doc v2")
      expect(
        (await writer.readTree(target, head1)).map((entry) => entry.version),
      ).toEqual(["v1", "v1"])
      const counter = { mutations: 0 }
      await writer.deleteTreeAbove(target, "main", 1, counter)
      expect(counter.mutations).toBe(1)
      expect(
        (await readOne(reader, at(target, 2), "doc.md"))?.document.title,
      ).toBe("Doc")
      // The file version stays: only the cleanup removes it.
      expect(
        (
          await writer.findFileVersions(target, [
            { docKey: "doc.md", version: "v2" },
          ])
        ).size,
      ).toBe(1)
    })

    it("a tombstone keeps the fields of its last file version and the relations that point at it", async () => {
      const deletedAt = new Date("2026-11-20T08:00:00.123Z")
      const [targetEntry] = (await writer.readTree(target, head1)).filter(
        (entry) => entry.docKey === "target.md",
      )
      if (!targetEntry) throw new Error("No tree row of target.md")
      await writer.writeTree(target, "main", 3, [{ ...targetEntry, deletedAt }])
      const stored = await readOne(reader, at(target, 3), "target.md")
      expect(stored?.document).toMatchObject({
        title: "Target",
        status: "deleted",
        deletedAt,
        error: "",
      })
      expect(stored?.chunks).toEqual([])
      expect(stored?.outgoing).toEqual([])
      // At tree version 1, doc.md points at target.md. Its file version v2 of
      // tree version 2 points at new.md instead.
      expect(
        (await readOne(reader, at(target, 1), "target.md"))?.incoming.map(
          (relation) => relation.srcDoc,
        ),
      ).toEqual(["doc.md"])
      expect(stored?.incoming).toEqual([])
      expect(await reader.listDocumentStatuses(at(target, 3))).toEqual([
        { docKey: "doc.md", status: "active" },
        { docKey: "new.md", status: "missing" },
        { docKey: "target.md", status: "deleted" },
      ])
    })

    it("a failed file version has its error and no content", async () => {
      await writer.writeFileVersions(target, [
        {
          ...rowsOf("", "broken.md"),
          chunks: [],
          relations: [],
          refKeys: [],
          version: "v1",
          error: "parse error",
        },
      ])
      await writer.writeTree(target, "main", 3, [
        { ...entryOf(rowsOf("", "broken.md"), "v1"), status: "failed" },
      ])
      const failed = await readOne(reader, at(target, 3), "broken.md")
      expect(failed?.document).toMatchObject({
        status: "failed",
        error: "parse error",
      })
      expect(failed?.chunks).toEqual([])
      expect(failed?.outgoing).toEqual([])
    })

    it("the cleanup deletes replaced tree rows, the rows of a branch with no head and unused file versions, after their grace times", async () => {
      // A branch with no head, for example the earlier name of a renamed
      // default branch.
      await put(writer, target, seed(), { branch: "master" })
      const counter = { mutations: 0 }
      const head2 = { branch: "main", treeVersion: 2 }
      // Before the grace times end, nothing goes.
      expect(
        await writer.cleanUp(target, {
          heads: [head2],
          replacedBefore: new Date("2026-01-01T00:00:00.000Z"),
          unusedBefore: new Date("2026-01-01T00:00:00.000Z"),
        }),
      ).toEqual({ treeRows: 0, fileVersions: 0 })
      const view = await readOne(reader, at(target, 2), "doc.md")
      // The tree row of doc.md at tree version 1 is replaced, and the branch
      // `master` goes. Then no tree row uses the file version v1 of doc.md,
      // so it goes too. A second pass finds nothing.
      expect(await cleanNow([head2], counter)).toEqual({
        treeRows: 3,
        fileVersions: 1,
      })
      expect(await cleanNow([head2], counter)).toEqual({
        treeRows: 0,
        fileVersions: 0,
      })
      expect(await readOne(reader, at(target, 2), "doc.md")).toEqual(view)
      expect(
        [
          ...(
            await writer.findFileVersions(target, [
              { docKey: "doc.md", version: "v1" },
              { docKey: "doc.md", version: "v2" },
              { docKey: "target.md", version: "v1" },
            ])
          ).keys(),
        ].sort(),
      ).toEqual(["doc.md\0v2", "target.md\0v1"])
      expect(await counts(target)).toEqual({
        documents: 2,
        chunks: 4,
        relations: 2,
        relations_in: 2,
        doc_refs: 2,
        trees: 2,
      })
      // Two DELETEs of trees, then one for each table of the file version
      // (doc_refs too, because doc.md states a key).
      expect(counter.mutations).toBe(2 + 5)
    })

    it("a key cannot change the predicates of a statement", async () => {
      const injected = "x') OR (1 = 1"
      await put(writer, target, [rowsOf("Injected", injected)], {
        version: injected,
        treeVersion: 3,
      })
      await writer.deleteTreeAbove(target, injected, 0)
      await cleanNow([{ branch: "main", treeVersion: 3 }])
      expect(
        (await reader.listDocumentStatuses(at(target, 3))).map(
          (row) => row.docKey,
        ),
      ).toEqual(expect.arrayContaining(["doc.md", "target.md", injected]))
    })
  })

  // The proof that the API cannot make a DELETE without both predicates: the
  // server logs the text of each statement that the tests above sent as the
  // writer user. Only the purge of an org (CTX-1642) has no Workspace
  // predicate: its only predicate is the org.
  it("each DELETE of the writer has the org and Workspace predicates first, or is the purge of an org, and the writer sends no other change", async () => {
    const admin = rawClient(adminUrl)
    await admin.command({ query: "SYSTEM FLUSH LOGS" })
    const statements = await rawRows<{ kind: string; query: string }>(
      admin,
      `SELECT query_kind AS kind, query FROM system.query_log
       WHERE type = 'QueryFinish' AND user = 'ctxpipe_writer'
         AND has(databases, currentDatabase())
         AND query_kind NOT IN ('Select', 'Insert', 'AsyncInsertFlush')
       ORDER BY event_time_microseconds`,
    )
    expect(new Set(statements.map((statement) => statement.kind))).toEqual(
      new Set(["Delete", "Alter"]),
    )
    for (const { kind, query } of statements)
      expect(query).toMatch(
        kind === "Alter"
          ? // The erase after a purge (CTX-1672) changes no visible row.
            /^ALTER TABLE \w+ APPLY DELETED MASK IN PARTITION ID '(\d+|all)'$/
          : /^DELETE FROM \w+ WHERE (\(org_id = '\w+'\) AND \(workspace_id = '\w+'\)( AND \(|$)|org_id = '\w+'$)/,
      )
    // The purges of the test above: the Workspace, then the org.
    expect(
      statements.filter(({ query }) => query.includes("'org_purge'")),
    ).toHaveLength(2 * KNOWLEDGE_TABLES.length)
  })
})

describe("reference keys", () => {
  it("lists each reference key target that no document of the view states, with its source", async () => {
    const store = createKnowledgeStore(await freshDatabase())
    try {
      // `key:target.md` is a key of target.md; `key:gone` is a key of no
      // document; `key:hidden.md` is a key of a file version with no tree
      // row.
      await put(store, orgA, [
        rowsOf("Source", "source.md", "ref:key:target.md"),
        rowsOf("Other", "other.md", "ref:key:gone"),
        rowsOf("Target", "target.md", "plain.md"),
        rowsOf("Seeker", "seeker.md", "ref:key:hidden.md"),
      ])
      await store.writeFileVersions(orgA, [
        { ...rowsOf("Hidden", "hidden.md"), version: "v1" },
      ])
      expect(await store.listUnresolvedReferences(at(orgA))).toEqual([
        { srcDoc: "other.md", dstDoc: "ref:key:gone" },
        { srcDoc: "seeker.md", dstDoc: "ref:key:hidden.md" },
      ])
      // The read is only for the Workspace of the scope.
      expect(await store.listUnresolvedReferences(at(orgB))).toEqual([])
    } finally {
      await store.close()
    }
  })
})
