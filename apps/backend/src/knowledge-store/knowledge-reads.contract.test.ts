import { type ClickHouseClient, ClickHouseError } from "@clickhouse/client"
import { trace } from "@opentelemetry/api"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { recordSpans } from "../../test/spans.js"
import { startClickHouse, userUrl } from "../test/clickhouse.js"
import {
  createKnowledgeStore,
  type DocumentRows,
  type FileRelation,
  type KnowledgeReadScope,
  type KnowledgeScope,
  type KnowledgeStore,
  ORG_SETTING,
  REFERENCE_TARGET_PREFIX,
  type SearchQuery,
  type TreeEntry,
} from "./knowledge-store.js"
import { migrateKnowledgeStore } from "./migrate.js"

/*
 * The reads of KnowledgeStore (ADR-068, ADR-071) against a real ClickHouse
 * of the pinned image: the hybrid search, the frontier relations, the
 * evidence read and the graph view read, each on the tree view of a head.
 * Org B has the same Workspace id and the same document keys as org A, and
 * its text says "Org B", so a row that crosses the org wall shows in each
 * result.
 */

const workspace = "ws_main"
const otherWorkspace = "ws_other"
/** The head of `ws_main` of org A: tree version 2 has the tombstone. */
const head = { workspaceId: workspace, branch: "main", treeVersion: 2 }
const orgA: KnowledgeReadScope = { orgId: "org_read_a", heads: [head] }
const orgB: KnowledgeReadScope = {
  orgId: "org_read_b",
  heads: [{ ...head, treeVersion: 1 }],
}
const otherHead = {
  workspaceId: otherWorkspace,
  branch: "main",
  treeVersion: 1,
}

const dimensions = 16
/** The query vector. No dimension is 0. */
const queryVector = Array.from(
  { length: dimensions },
  (_, i) => (((i * 7) % 5) - 1.5) / 3,
)
const opposite = queryVector.map((value) => -value)
/** Near the query: the signs of two dimensions are flipped. */
const nearQuery = (seed: number) =>
  queryVector.map((value, i) =>
    i === seed % dimensions || i === (seed + 5) % dimensions
      ? -value * 0.5
      : value,
  )

const observedAt = new Date("2026-11-19T10:11:12.345Z")

/**
 * The rows of a document. Its tree row has the times of the document, as
 * when the file states each of them.
 */
function document(
  docKey: string,
  chunks: { text: string; embedding: number[] }[],
  options: Partial<DocumentRows["document"]> & {
    relations?: Partial<FileRelation>[]
    refKeys?: string[]
  } = {},
): DocumentRows {
  const { relations = [], refKeys, ...fields } = options
  return {
    refKeys,
    document: {
      docKey,
      kind: "note",
      title: docKey,
      path: `notes/${docKey}`,
      sourceType: "git",
      source: "workspace",
      summary: "",
      mime: "",
      createdAt: null,
      updatedAt: null,
      expiresAt: null,
      observedAt,
      ...fields,
    },
    // Each chunk has its own file lines, so a read shows which chunk it gave.
    chunks: chunks.map((chunk, ordinal) => ({
      ordinal,
      startLine: ordinal * 4 + 1,
      endLine: ordinal * 4 + 3,
      ...chunk,
    })),
    relations: relations.map((relation) => ({
      srcChunk: 0,
      predicate: "REFERENCES",
      dstDoc: "",
      confidence: 1,
      validFrom: null,
      validFromIntroduced: false,
      validTo: null,
      source: "link",
      altText: "",
      observedAt,
      ...relation,
    })),
  }
}

/** The documents of org A in `ws_main`. */
const orgADocuments: DocumentRows[] = [
  // The closest vector. No query term.
  document(
    "vector.md",
    [
      { text: "plain words only", embedding: queryVector },
      { text: "far section", embedding: opposite },
    ],
    {
      relations: [
        { dstDoc: "lexical.md", altText: "The lexical diagram" },
        { dstDoc: "ghost.md", predicate: "MENTIONS" },
      ],
    },
  ),
  // The query term, with the farthest vector.
  document("lexical.md", [
    { text: "the zebracorn term appears", embedding: opposite },
  ]),
  // The query term in the text and in the title: the title boost.
  document(
    "titled.md",
    [{ text: "a zebracorn here too", embedding: opposite }],
    { title: "zebracorn notes" },
  ),
  // Close vector and the query term. The seed deletes it.
  document("deleted.md", [
    { text: "zebracorn deleted", embedding: queryVector },
  ]),
  // Close vector and the query term, of 2020. A late projection observed
  // it: the projection time is no time of the document.
  document("old.md", [{ text: "zebracorn of 2020", embedding: nearQuery(7) }], {
    // A file of the Linear mirror.
    path: "linear/old.md",
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    updatedAt: new Date("2020-06-01T00:00:00.000Z"),
    expiresAt: new Date("2021-01-01T00:00:00.000Z"),
    observedAt: new Date("2026-11-25T00:00:00.000Z"),
    relations: [{ dstDoc: "vector.md" }],
  }),
  document(
    "guides/setup.md",
    [{ text: "setup guide", embedding: nearQuery(3) }],
    {
      kind: "guide",
      path: "guides/setup.md",
      updatedAt: new Date("2026-11-20T00:00:00.000Z"),
    },
  ),
  // More than 50 chunks near the query, so that the top 50 is a choice.
  ...Array.from({ length: 80 }, (_, i) =>
    document(
      `filler-${String(i).padStart(2, "0")}.md`,
      [{ text: `filler text ${i}`, embedding: nearQuery(i) }],
      {
        relations:
          i === 1
            ? [{ dstDoc: "vector.md", predicate: "DEPENDS_ON" }]
            : i === 2
              ? [
                  {
                    dstDoc: "vector.md",
                    validTo: new Date("2021-01-01T00:00:00.000Z"),
                  },
                ]
              : i === 3
                ? // A claim with no time of its own: it takes the time of
                  // the commit that introduced its file on the branch.
                  [
                    {
                      dstDoc: "vector.md",
                      predicate: "SUPPORTS",
                      validFromIntroduced: true,
                    },
                  ]
                : [],
        ...(i === 3 ? { createdAt: new Date("2030-01-01T00:00:00.000Z") } : {}),
      },
    ),
  ),
]

/** Org B: the same Workspace id and keys, other text. */
const orgBDocuments: DocumentRows[] = [
  document("vector.md", [{ text: "Org B zebracorn", embedding: queryVector }], {
    title: "Org B vector",
    relations: [{ dstDoc: "org-b-target.md" }],
  }),
  document(
    "lexical.md",
    [{ text: "Org B zebracorn", embedding: queryVector }],
    {
      title: "Org B lexical",
      relations: [{ dstDoc: "vector.md" }],
    },
  ),
  document(
    "org-b-target.md",
    [{ text: "Org B target", embedding: queryVector }],
    {
      title: "Org B target",
    },
  ),
]

let clickHouse: Awaited<ReturnType<typeof startClickHouse>>
const rawClient = (url: string) => clickHouse.client(url)

/** The reader password of the backend user (`ctxpipe_reader`). */
const readerPassword = "reader-test"

/** The tree row of the file version `version` of `rows`. */
const entryOf = (rows: DocumentRows, version: string): TreeEntry => ({
  docKey: rows.document.docKey,
  version,
  path: rows.document.path,
  status: "active",
  kind: rows.document.kind,
  observedAt: rows.document.observedAt,
  createdAt: rows.document.createdAt,
  updatedAt: rows.document.updatedAt,
  expiresAt: rows.document.expiresAt,
  deletedAt: null,
})

/**
 * Writes the file version `version` of each of `documents`, and its tree row
 * of `main` with the tree version `treeVersion`.
 */
async function seed(
  store: KnowledgeStore,
  scope: KnowledgeScope,
  documents: DocumentRows[],
  { version = "v1", treeVersion = 1 } = {},
): Promise<void> {
  await store.writeFileVersions(
    scope,
    documents.map((rows) => ({ ...rows, version })),
  )
  await store.writeTree(
    scope,
    "main",
    treeVersion,
    documents.map((rows) => entryOf(rows, version)),
  )
}

/**
 * A database with the documents of both orgs. `prepare` runs on the empty
 * tables. Returns its URL.
 */
async function seededDatabase(
  prepare: (client: ClickHouseClient) => Promise<void> = async () => {},
): Promise<string> {
  const url = await clickHouse.freshDatabase()
  const client = rawClient(url)
  await prepare(client)
  const store = createKnowledgeStore(url)
  try {
    const inMain = { orgId: orgA.orgId, workspaceId: workspace }
    await seed(store, inMain, orgADocuments)
    // Tree version 2: `deleted.md` becomes a tombstone. Its file version
    // keeps its chunks, and the search must still not find them.
    const deleted = orgADocuments.find(
      (rows) => rows.document.docKey === "deleted.md",
    )
    if (!deleted) throw new Error("No deleted.md")
    await store.writeTree(inMain, "main", 2, [
      { ...entryOf(deleted, "v1"), deletedAt: observedAt },
    ])
    // Tree version 3, above the head: a run that did not complete. No read
    // sees its rows.
    await seed(
      store,
      inMain,
      [
        document("unfinished.md", [
          { text: "zebracorn unfinished", embedding: queryVector },
        ]),
        document(
          "lexical.md",
          [{ text: "the zebracorn term changed", embedding: queryVector }],
          { title: "Unfinished lexical" },
        ),
      ],
      { version: "v2", treeVersion: 3 },
    )
    await seed(store, { orgId: orgA.orgId, workspaceId: otherWorkspace }, [
      document("other.md", [
        { text: "zebracorn elsewhere", embedding: queryVector },
      ]),
    ])
    await seed(
      store,
      { orgId: orgB.orgId, workspaceId: workspace },
      orgBDocuments,
    )
  } finally {
    await store.close()
  }
  return url
}

/**
 * Writes `count` active documents straight to the tables of the database
 * `url` (key `<prefix><number>.md`), each with `chunks` chunks of `text` and
 * `vector`. The writes are fast, so a test can make many documents.
 */
const filler =
  (url: string) =>
  async (
    kind: string,
    prefix: string,
    count: number,
    text: string,
    vector: number[],
    { chunks = 1 }: { chunks?: number } = {},
  ) => {
    const client = rawClient(url)
    const settings = { [ORG_SETTING]: orgA.orgId }
    const params = {
      orgId: orgA.orgId,
      workspace,
      kind,
      prefix,
      count,
      chunks,
      text,
      vector,
    }
    const docKey = `concat({prefix:String}, leftPad(toString(number), 5, '0'), '.md')`
    await client.command({
      query: `INSERT INTO documents (org_id, workspace_id, doc_key, version,
          kind, status, title, path, observed_at)
        SELECT {orgId:String}, {workspace:String}, ${docKey}, 'v1',
          {kind:String}, 'active', '', '', now64(3)
        FROM numbers({count:UInt32})`,
      query_params: params,
      clickhouse_settings: settings,
    })
    await client.command({
      query: `INSERT INTO trees (org_id, workspace_id, branch, doc_key,
          tree_version, kind, path, version, status, doc_kind, observed_at)
        SELECT {orgId:String}, {workspace:String}, 'main', ${docKey}, 1,
          'file', '', 'v1', 'active', {kind:String}, now64(3)
        FROM numbers({count:UInt32})`,
      query_params: params,
      clickhouse_settings: settings,
    })
    await client.command({
      query: `INSERT INTO chunks (org_id, workspace_id, doc_key, version,
          ordinal, text, embedding)
        SELECT {orgId:String}, {workspace:String}, ${docKey}, 'v1',
          ordinal, {text:String}, {vector:Array(Float32)}
        FROM numbers({count:UInt32})
        ARRAY JOIN range({chunks:UInt32}) AS ordinal`,
      query_params: params,
      clickhouse_settings: settings,
    })
  }

/**
 * One search of org A at tree version 1 of the database `url`, the database
 * of a test that writes with `filler`.
 */
async function searchIn(url: string, query: Partial<SearchQuery>) {
  const reader = createKnowledgeStore(url)
  try {
    return await reader.search(
      { ...orgA, heads: [{ ...head, treeVersion: 1 }] },
      { vector: queryVector, terms: [], chunksPerDocument: 2, ...query },
    )
  } finally {
    await reader.close()
  }
}

const spans = recordSpans()

let store: ReturnType<typeof createKnowledgeStore>
/** The admin URL of the database of `store`. */
let storeUrl: string

beforeAll(async () => {
  clickHouse = await startClickHouse()
  // The backend reads as the reader user, with SELECT only. Only this
  // database gets the users: their grants name the tables of one database.
  const url = await seededDatabase()
  storeUrl = url
  await migrateKnowledgeStore(url, {
    reader: readerPassword,
    writer: "writer-test",
  })
  store = createKnowledgeStore(userUrl(url, "ctxpipe_reader", readerPassword))
}, 240_000)

afterAll(async () => {
  await store?.close()
  await clickHouse?.stop()
})

const search = (options: Partial<SearchQuery>, scope = orgA) =>
  store.search(scope, {
    vector: queryVector,
    terms: [],
    chunksPerDocument: 2,
    ...options,
  })
const hitKeys = (hits: Awaited<ReturnType<typeof search>>) =>
  hits.map((hit) => hit.document.docKey)

describe("search", () => {
  it("vector: the closest chunk is first, and a far chunk with no query term is not in the top 50", async () => {
    const hits = await search({})
    expect(hits[0]?.document.docKey).toBe("vector.md")
    expect(hits[0]?.chunks[0]).toEqual({
      ordinal: 0,
      text: "plain words only",
      startLine: 1,
      endLine: 3,
      score: expect.any(Number),
    })
    expect(hits).toHaveLength(50)
    expect(hitKeys(hits)).not.toContain("lexical.md")
    expect(hitKeys(hits)).not.toContain("titled.md")
  })

  it("lexical: a query term brings in chunks with the farthest vector, and the title match ranks first", async () => {
    const hits = await search({ terms: ["zebracorn"] })
    const keys = hitKeys(hits)
    expect(keys).toContain("vector.md")
    expect(keys).toContain("lexical.md")
    // Both have the farthest vector; the title match ranks first.
    expect(keys.indexOf("titled.md")).toBeGreaterThanOrEqual(0)
    expect(keys.indexOf("titled.md")).toBeLessThan(keys.indexOf("lexical.md"))
    expect(
      hits.find((hit) => hit.document.docKey === "lexical.md")?.chunks,
    ).toEqual([
      {
        ordinal: 0,
        text: "the zebracorn term appears",
        startLine: 1,
        endLine: 3,
        score: expect.any(Number),
      },
    ])
    // The term matches case-sensitively, like the text index.
    expect(hitKeys(await search({ terms: ["Zebracorn"] }))).not.toContain(
      "lexical.md",
    )
  })

  it("a term with separators counts as its tokens, and does not fail", async () => {
    const keys = hitKeys(
      await search({ terms: ["zebracorn-term", "two words", "a_b", "-"] }),
    )
    expect(keys).toContain("lexical.md")
  })

  it("lexical: the query runs before the query vector is ready, and the hits do not change", async () => {
    // The finished lexical queries of the reader (the only query with
    // hasToken), from the query log of the server.
    const admin = rawClient(storeUrl)
    const lexicalQueries = async () => {
      await admin.command({ query: "SYSTEM FLUSH LOGS" })
      const result = await admin.query({
        query: `SELECT count() AS count FROM system.query_log
          WHERE type = 'QueryFinish' AND user = 'ctxpipe_reader'
            AND has(databases, currentDatabase())
            AND position(query, 'hasToken') > 0`,
        format: "JSONEachRow",
      })
      const [row] = await result.json<{ count: string }>()
      return Number(row?.count)
    }
    const before = await lexicalQueries()
    let give: (vector: number[]) => void = () => {}
    const pending = search({
      vector: new Promise<number[]>((resolve) => {
        give = resolve
      }),
      terms: ["zebracorn"],
    })
    // The vector is not ready, so only the lexical query can finish.
    await expect.poll(lexicalQueries, { timeout: 30_000 }).toBe(before + 1)
    give(queryVector)
    expect(hitKeys(await pending)).toEqual(
      hitKeys(await search({ terms: ["zebracorn"] })),
    )
  })

  it("lexical: the cap of each term applies after the filters", async () => {
    // 1200 chunks of excluded documents sort before the one chunk that the
    // filter allows, and all have the term. 600 allowed chunks are nearer
    // to the query vector, so only the lexical part can find it.
    const url = await clickHouse.freshDatabase()
    const fill = filler(url)
    await fill("note", "a-excluded-", 1200, "capword", opposite)
    await fill("guide", "m-near-", 600, "near", queryVector)
    await fill("guide", "z-target-", 1, "capword", opposite)
    expect(
      hitKeys(await searchIn(url, { terms: ["capword"], kinds: ["guide"] })),
    ).toContain("z-target-00000.md")
    // Without the term, the vector part alone does not find it.
    expect(
      hitKeys(await searchIn(url, { terms: [], kinds: ["guide"] })),
    ).not.toContain("z-target-00000.md")
  })

  it("the same query gives the same hits on each run, also when many chunks tie at a cut", async () => {
    // 1800 chunks in three parts have the same vector and the same term, so
    // they tie at the Hamming cut of 500 and at the cap of 1000 chunks of the
    // term. A cut with no order takes the chunks that the parallel read
    // gives first, and that changes from run to run (CTX-1547).
    const url = await clickHouse.freshDatabase()
    const fill = filler(url)
    for (const part of ["a", "m", "z"])
      await fill("guide", `${part}-tie-`, 600, "tieword", nearQuery(3))
    const runs = []
    for (let run = 0; run < 5; run++)
      runs.push(hitKeys(await searchIn(url, { terms: ["tieword"] })))
    expect(runs[0]).toHaveLength(50)
    for (const keys of runs) expect(keys).toEqual(runs[0])
  })

  it("the top 50 is 50 documents: a document with many close chunks takes one place", async () => {
    // One document has 60 chunks at the query vector. 60 documents have one
    // chunk each, farther away. A cut at 50 chunks would give only the long
    // document.
    const url = await clickHouse.freshDatabase()
    const fill = filler(url)
    await fill("guide", "a-long-", 1, "long text", queryVector, { chunks: 60 })
    await fill("guide", "m-short-", 60, "short text", nearQuery(1))
    const hits = await searchIn(url, { terms: [] })
    expect(hits).toHaveLength(50)
    expect(hits[0]?.document.docKey).toBe("a-long-00000.md")
    // The hit keeps its best chunks, at most `chunksPerDocument`.
    expect(hits[0]?.chunks).toHaveLength(2)
    expect(new Set(hitKeys(hits)).size).toBe(50)
  })

  it("lexical: a rare query term weighs more than common ones", async () => {
    // 60 documents match the two common terms, and one document matches
    // only the rare term. All chunks have the same vector, and the rare
    // document sorts first by key, so it is first in the vector order. A
    // count of the matched terms puts it last in the lexical order, and
    // the fusion then puts it near place 20. With the term weight, it is
    // first in both orders.
    const url = await clickHouse.freshDatabase()
    const fill = filler(url)
    await fill("guide", "m-common-", 60, "the plan of record", queryVector)
    await fill("guide", "a-rare-", 1, "zebracorn", queryVector)
    const hits = await searchIn(url, { terms: ["the", "of", "zebracorn"] })
    expect(hits[0]?.document.docKey).toBe("a-rare-00000.md")
  })

  it("fusion: a lexical chunk with a small share of the query terms counts less than a vector chunk at the same place", async () => {
    // 500 chunks near the query vector fill the vector order, so the other
    // chunks are only in the lexical order. 60 chunks have one common query
    // term, and one chunk has all five terms (CTX-1564).
    const url = await clickHouse.freshDatabase()
    const fill = filler(url)
    await fill("guide", "v-near-", 500, "plain words", nearQuery(1))
    await fill("guide", "n-common-", 60, "alpha words", opposite)
    await fill("guide", "z-all-", 1, "alpha bravo charlie delta echo", opposite)
    const terms = ["alpha", "bravo", "charlie", "delta", "echo"]
    const hits = await searchIn(url, { terms })
    const keys = hitKeys(hits)
    expect(keys).toHaveLength(50)
    // The terms have different weights, and the shares come from parallel
    // sums: each run gives the same hits with the same scores.
    for (let run = 0; run < 4; run++)
      expect(await searchIn(url, { terms })).toEqual(hits)
    // The chunk with all terms keeps the full weight of its lexical place:
    // it ties with the first vector chunk.
    expect(keys.slice(0, 2)).toContain("z-all-00000.md")
    // With the full weight, the chunks with one common term would take
    // about half of the top 50.
    expect(keys.filter((key) => key.startsWith("n-common-"))).toEqual([])
    // A query term that no chunk has does not lower the share of the chunk
    // with all the other terms.
    const withUnknown = hitKeys(
      await searchIn(url, {
        terms: ["alpha", "bravo", "charlie", "delta", "echo", "nowhereword"],
      }),
    )
    expect(withUnknown.slice(0, 2)).toContain("z-all-00000.md")
  })

  it("fusion: a chunk with all terms keeps the full weight when the cap of a common term does not take it", async () => {
    // 1100 chunks and the target have both common terms. The cap of 1000
    // chunks for each term takes the chunks in the order of a hash of their
    // key, and the key of the target sorts after 1069 of the 1100 others,
    // so neither common branch takes it. Only the target has the rare
    // term. 500 chunks near the query vector fill the vector order, and
    // 1500 more chunks make the common terms weigh more (CTX-1564).
    const url = await clickHouse.freshDatabase()
    const fill = filler(url)
    await fill("guide", "v-near-", 500, "plain words", nearQuery(1))
    await fill("guide", "p-pad-", 1500, "plain words", opposite)
    await fill("guide", "c-common-", 1100, "commonone commontwo", opposite)
    await fill("guide", "z-doc-", 1, "commonone commontwo rareword", opposite)
    const keys = hitKeys(
      await searchIn(url, { terms: ["commonone", "commontwo", "rareword"] }),
    )
    expect(keys.slice(0, 2)).toContain("z-doc-00000.md")
  })

  it("neighbors: the documents that the best hits have a relation to take the last places, the closest first", async () => {
    // The first k dimensions of the query vector flipped: a larger k is
    // farther. Each such document is farther than the 60 fillers, so it is
    // no hit, and only a relation of a best hit can bring it in.
    const far = (k: number) =>
      queryVector.map((value, i) => (i < k ? -value : value))
    const key = (name: string) => `${REFERENCE_TARGET_PREFIX}${name}`
    const url = await clickHouse.freshDatabase()
    await filler(url)("note", "filler-", 60, "filler", nearQuery(1))
    const writer = createKnowledgeStore(url)
    try {
      await seed(writer, { orgId: orgA.orgId, workspaceId: workspace }, [
        document("issue.md", [{ text: "the issue", embedding: queryVector }], {
          refKeys: ["issue-key"],
          relations: [
            // A mention of a key goes to the documents of the key.
            { dstDoc: key("mailer"), predicate: "MENTIONS" },
            { dstDoc: "out.md" },
            { dstDoc: "guide.md" },
            { dstDoc: "expired.md" },
            { dstDoc: "old-out.md", validTo: new Date("2021-01-01") },
            // The relation to the source of a file is no neighbor.
            { dstDoc: "source.md", predicate: "FROM_SOURCE" },
          ],
        }),
        document("mailer.md", [{ text: "sends mail", embedding: far(8) }], {
          refKeys: ["mailer"],
        }),
        document("guide.md", [{ text: "a guide", embedding: far(9) }], {
          kind: "guide",
        }),
        document("out.md", [{ text: "named", embedding: far(10) }]),
        document("expired.md", [{ text: "of 2020", embedding: far(11) }], {
          expiresAt: new Date("2021-01-01T00:00:00.000Z"),
        }),
        // In-relations: to the issue, and to a key of the issue.
        document("in.md", [{ text: "names it", embedding: far(12) }], {
          relations: [{ dstDoc: "issue.md" }],
        }),
        document("keyed-in.md", [{ text: "by key", embedding: far(13) }], {
          relations: [{ dstDoc: key("issue-key"), predicate: "MENTIONS" }],
        }),
        document("old-out.md", [{ text: "was named", embedding: far(14) }]),
        document("old-in.md", [{ text: "named it", embedding: far(15) }], {
          relations: [{ dstDoc: "issue.md", validTo: new Date("2021-01-01") }],
        }),
        // Closer than the neighbors, with no relation that counts.
        document("source.md", [{ text: "the source", embedding: far(7) }]),
        document("lonely.md", [{ text: "no relation", embedding: far(7) }]),
      ])
    } finally {
      await writer.close()
    }
    const plain = await searchIn(url, {})
    expect(plain).toHaveLength(50)
    expect(plain[0]?.document.docKey).toBe("issue.md")
    const neighbors = { from: 5, places: 10 }
    const found = await searchIn(url, { neighbors })
    expect(found).toHaveLength(50)
    expect(hitKeys(found).slice(0, 42)).toEqual(hitKeys(plain).slice(0, 42))
    expect(hitKeys(found).slice(42)).toEqual([
      "mailer.md",
      "guide.md",
      "out.md",
      "expired.md",
      "in.md",
      "keyed-in.md",
      "old-out.md",
      "old-in.md",
    ])
    // A neighbor has its closest chunks and its document, and the score of
    // the hit whose place it takes, so the search order keeps it there.
    expect(found[42]?.document).toMatchObject({
      path: "notes/mailer.md",
      title: "mailer.md",
      sourceType: "git",
      status: "active",
    })
    expect(found[42]?.chunks).toEqual([
      expect.objectContaining({
        ordinal: 0,
        text: "sends mail",
        score: plain[42]?.chunks[0]?.score,
      }),
    ])
    expect(found[49]?.chunks[0]?.score).toBe(plain[49]?.chunks[0]?.score)
    // At most `places` neighbors, the closest first.
    expect(
      hitKeys(await searchIn(url, { neighbors: { from: 5, places: 2 } })).slice(
        48,
      ),
    ).toEqual(["mailer.md", "guide.md"])
    // A neighbor must pass the filters of the search. No time filters a
    // neighbor or its relation: an expired document and an ended relation
    // stay (CTX-1710).
    expect(
      hitKeys(await searchIn(url, { neighbors, kinds: ["note"] })).slice(43),
    ).toEqual([
      "mailer.md",
      "out.md",
      "expired.md",
      "in.md",
      "keyed-in.md",
      "old-out.md",
      "old-in.md",
    ])
    // When the signal aborts before the read of the neighbors ends, the
    // search gives its hits without neighbors.
    const end = new AbortController()
    const stopped = searchIn(url, {
      neighbors: { ...neighbors, signal: end.signal },
    })
    end.abort()
    expect(hitKeys(await stopped)).toEqual(hitKeys(plain))
    // Only the relations of the first `from` hits count.
    expect(
      hitKeys(await searchIn(url, { neighbors: { from: 0, places: 10 } })),
    ).toEqual(hitKeys(plain))
  })

  it("never finds a deleted document", async () => {
    const keys = hitKeys(await search({ terms: ["zebracorn", "deleted"] }))
    expect(keys).not.toContain("deleted.md")
    expect(keys).toContain("lexical.md")
  })

  it("filters by kind and by path prefix", async () => {
    expect(hitKeys(await search({ kinds: ["guide"] }))).toEqual([
      "guides/setup.md",
    ])
    expect(hitKeys(await search({ pathPrefix: "guides/" }))).toEqual([
      "guides/setup.md",
    ])
  })

  it("filters by source and by the time a document changed in its source (CTX-1710)", async () => {
    // The source is the mirror root of the path, else authored.
    expect(
      hitKeys(await search({ terms: ["zebracorn"], sources: ["linear"] })),
    ).toEqual(["old.md"])
    expect(
      hitKeys(await search({ terms: ["zebracorn"], sources: ["authored"] })),
    ).not.toContain("old.md")
    // old.md was observed after that time, but it changed in 2020. A
    // document with no updatedAt is not found.
    expect(
      hitKeys(
        await search({ updatedAfter: new Date("2026-11-19T12:00:00.000Z") }),
      ),
    ).toEqual(["guides/setup.md"])
    // Only the two documents with an updatedAt have one after May 2020.
    expect(
      hitKeys(
        await search({
          terms: ["zebracorn"],
          updatedAfter: new Date("2020-05-01T00:00:00.000Z"),
        }),
      ).sort(),
    ).toEqual(["guides/setup.md", "old.md"])
    expect(
      hitKeys(
        await search({ terms: ["zebracorn"], sources: ["linear", "authored"] }),
      ),
    ).toEqual(expect.arrayContaining(["old.md", "lexical.md"]))
  })

  it("searches several Workspaces of the org in one call", async () => {
    expect(hitKeys(await search({ terms: ["elsewhere"] }))).not.toContain(
      "other.md",
    )
    const hits = await search(
      { terms: ["elsewhere"] },
      { orgId: orgA.orgId, heads: [head, otherHead] },
    )
    expect(
      hits.find((hit) => hit.document.docKey === "other.md")?.workspaceId,
    ).toBe(otherWorkspace)
  })

  it("refuses a read without an org, a Workspace or a branch", async () => {
    const refused = /one head for each of its Workspaces/
    await expect(
      store.search(
        { orgId: orgA.orgId, heads: [] },
        { vector: queryVector, terms: [], chunksPerDocument: 2 },
      ),
    ).rejects.toThrow(refused)
    await expect(
      store.readFrontier({ orgId: "", heads: [head] }, []),
    ).rejects.toThrow(refused)
    await expect(
      store.readDocuments(
        { orgId: orgA.orgId, heads: [{ ...head, branch: "" }] },
        [],
      ),
    ).rejects.toThrow(refused)
  })
})

describe("refused request (CTX-1688)", () => {
  it("gives a ClickHouseError with the code when ClickHouse refuses the request before the query runs", async () => {
    // A query parameter of more than 128 KiB: the HTTP handler of
    // ClickHouse refuses it with a Poco exception, not a DB::Exception.
    const refs = Array.from({ length: 3_000 }, (_, i) => ({
      workspaceId: workspace,
      docKey: `missing/${String(i).padStart(4, "0")}-${"x".repeat(40)}.md`,
    }))
    const error = await store.readFrontier(orgA, refs).catch((e) => e)
    expect(error).toBeInstanceOf(ClickHouseError)
    expect(error).toMatchObject({ code: "1000" })
  })
})

describe("read spans (CTX-1688)", () => {
  it("gives each ClickHouse read of a request a span with the name of its statement", async () => {
    await trace
      .getTracer("test")
      .startActiveSpan("request", async (request) => {
        await search({
          terms: ["vector"],
          neighbors: { from: 5, places: 10 },
        })
        request.end()
      })
    const request = spans.spanNamed("request")
    const reads = spans
      .finishedSpans()
      .filter((span) => span.name.startsWith("clickhouse "))
    expect(reads.map((span) => span.name).sort()).toEqual([
      "clickhouse search.chunks",
      "clickhouse search.documents",
      "clickhouse search.lexical",
      "clickhouse search.neighbor_chunks",
      "clickhouse search.neighbor_documents",
      "clickhouse search.neighbors",
      "clickhouse search.vector",
    ])
    for (const span of reads) {
      expect(span.parentSpanContext?.spanId).toBe(request?.spanContext().spanId)
      expect(span.attributes).toMatchObject({
        "db.system.name": "clickhouse",
        "db.operation.name": "SELECT",
      })
      expect(span.attributes["db.response.returned_rows"]).toBeTypeOf("number")
    }
  })

  it("gives a read with no active span no span", async () => {
    await search({ terms: ["vector"] })
    expect(
      spans
        .finishedSpans()
        .filter((span) => span.name.startsWith("clickhouse ")),
    ).toEqual([])
  })
})

describe("tree view (ADR-071 decision 4)", () => {
  it("shows the tree at the head: a row above the head is not seen until the head moves", async () => {
    const unfinished = [
      { workspaceId: workspace, docKey: "unfinished.md" },
      { workspaceId: workspace, docKey: "lexical.md" },
    ]
    expect(
      (await store.readDocuments(orgA, unfinished)).map(
        ({ document }) => document.title,
      ),
    ).toEqual(["lexical.md"])
    expect(hitKeys(await search({ terms: ["unfinished"] }))).not.toContain(
      "unfinished.md",
    )
    // At tree version 3, the rows of the run show, and its new file version
    // of lexical.md replaces the old one.
    const moved = { ...orgA, heads: [{ ...head, treeVersion: 3 }] }
    expect(
      (await store.readDocuments(moved, unfinished)).map(
        ({ document }) => document.title,
      ),
    ).toEqual(["Unfinished lexical", "unfinished.md"])
    expect(hitKeys(await search({ terms: ["unfinished"] }, moved))).toContain(
      "unfinished.md",
    )
    const hits = await search({ terms: ["zebracorn"] }, moved)
    expect(
      hits.find((hit) => hit.document.docKey === "lexical.md")?.chunks[0]?.text,
    ).toBe("the zebracorn term changed")
    // At tree version 1, the tombstone of tree version 2 is not there yet.
    const earlier = { ...orgA, heads: [{ ...head, treeVersion: 1 }] }
    expect(hitKeys(await search({ terms: ["deleted"] }, earlier))).toContain(
      "deleted.md",
    )
  })

  it("gives each document the status, the deletion time and the times of its tree row", async () => {
    const [deleted] = await store.readDocuments(orgA, [
      { workspaceId: workspace, docKey: "deleted.md" },
    ])
    expect(deleted?.document).toMatchObject({
      status: "deleted",
      deletedAt: observedAt,
      title: "deleted.md",
    })
    const [old] = await store.readDocuments(orgA, [
      { workspaceId: workspace, docKey: "old.md" },
    ])
    expect(old?.document).toMatchObject({
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      updatedAt: new Date("2020-06-01T00:00:00.000Z"),
      expiresAt: new Date("2021-01-01T00:00:00.000Z"),
    })
  })
})

describe("frontier relations", () => {
  const frontier = () =>
    store.readFrontier(orgA, [{ workspaceId: workspace, docKey: "vector.md" }])

  it("returns the out-relations and the in-relations, each with its neighbor document", async () => {
    const relations = await frontier()
    expect(
      relations.map((row) => [
        row.direction,
        row.relation.srcDoc,
        row.relation.predicate,
        row.relation.dstDoc,
        row.neighbor.status,
      ]),
    ).toEqual([
      // A target with no tree row is `missing` (ADR-071 decision 5).
      ["out", "vector.md", "MENTIONS", "ghost.md", "missing"],
      ["out", "vector.md", "REFERENCES", "lexical.md", "active"],
      ["in", "filler-01.md", "DEPENDS_ON", "vector.md", "active"],
      ["in", "filler-02.md", "REFERENCES", "vector.md", "active"],
      ["in", "filler-03.md", "SUPPORTS", "vector.md", "active"],
      ["in", "old.md", "REFERENCES", "vector.md", "active"],
    ])
    expect(relations.every((row) => row.workspaceId === workspace)).toBe(true)
    expect(relations.map((row) => row.relation.altText)).toEqual([
      "",
      "The lexical diagram",
      "",
      "",
      "",
      "",
    ])
    // The claim of filler-03 has the `created_at` of its tree row.
    expect(
      relations.find((row) => row.relation.srcDoc === "filler-03.md")?.relation
        .validFrom,
    ).toEqual(new Date("2030-01-01T00:00:00.000Z"))
    expect(relations[1]?.neighbor).toEqual({
      ...orgADocuments[1]?.document,
      status: "active",
      deletedAt: null,
      error: "",
    })
  })

  it("out: returns only the out-relations, the same as the out-relations of a read in both directions (CTX-1688)", async () => {
    const refs = [{ workspaceId: workspace, docKey: "vector.md" }]
    const both = await store.readFrontier(orgA, refs)
    const out = await store.readFrontier(orgA, refs, "out")
    expect(out.length).toBeGreaterThan(0)
    expect(out).toEqual(both.filter((row) => row.direction === "out"))
  })

  it("filters no relation by time: each relation shows its validFrom and validTo (CTX-1710)", async () => {
    const relations = await frontier()
    expect(
      relations.find((row) => row.relation.srcDoc === "filler-02.md")?.relation
        .validTo,
    ).toEqual(new Date("2021-01-01T00:00:00.000Z"))
    // A neighbor that expired stays, with its expiresAt.
    expect(
      relations.find((row) => row.relation.srcDoc === "old.md")?.neighbor,
    ).toMatchObject({ expiresAt: new Date("2021-01-01T00:00:00.000Z") })
  })
})

describe("document read", () => {
  it("returns the row of each document that has one, with no chunks", async () => {
    const documents = await store.readDocuments(orgA, [
      { workspaceId: workspace, docKey: "vector.md" },
      { workspaceId: workspace, docKey: "ghost.md" },
      { workspaceId: otherWorkspace, docKey: "vector.md" },
    ])
    expect(
      documents.map(({ workspaceId, document }) => [
        workspaceId,
        document.docKey,
        document.status,
      ]),
    ).toEqual([[workspace, "vector.md", "active"]])
  })

  it("reads the documents of more refs than one query parameter can hold (CTX-1688)", async () => {
    // ClickHouse refuses a query parameter of more than 128 KiB
    // (`http_max_field_value_size`): 3,000 refs are about 230 KiB.
    const refs = [
      { workspaceId: workspace, docKey: "vector.md" },
      ...Array.from({ length: 3_000 }, (_, i) => ({
        workspaceId: workspace,
        docKey: `missing/${String(i).padStart(4, "0")}-${"x".repeat(40)}.md`,
      })),
    ]
    const documents = await store.readDocuments(orgA, refs)
    expect(documents.map(({ document }) => document.docKey)).toEqual([
      "vector.md",
    ])
  })

  it("counts the bytes of a key with characters outside ASCII (CTX-1688)", async () => {
    // 3 bytes in UTF-8 for each character: 1,500 keys of 40 characters
    // are about 180 KiB, but less than 64 K characters.
    const refs = Array.from({ length: 1_500 }, (_, i) => ({
      workspaceId: workspace,
      docKey: `${String(i).padStart(4, "0")}-${"文".repeat(40)}.md`,
    }))
    expect(await store.readDocuments(orgA, refs)).toEqual([])
  })

  it("counts the escapes of a key with quotes and backslashes (CTX-1688)", async () => {
    // The client escapes each quote and backslash, and the URL encodes
    // both characters: 1,500 such keys are about 290 KiB in the URL.
    const refs = Array.from({ length: 1_500 }, (_, i) => ({
      workspaceId: workspace,
      docKey: `${String(i).padStart(4, "0")}-${"'\\".repeat(20)}.md`,
    }))
    expect(await store.readDocuments(orgA, refs)).toEqual([])
  })
})

describe("evidence read", () => {
  it("returns each document with its chunks closest to the query vector", async () => {
    const evidence = await store.readEvidence(
      orgA,
      [
        { workspaceId: workspace, docKey: "vector.md" },
        { workspaceId: workspace, docKey: "deleted.md" },
      ],
      queryVector,
      1,
    )
    const byKey = Object.fromEntries(
      evidence.map((item) => [item.document.docKey, item]),
    )
    expect(Object.keys(byKey).sort()).toEqual(["deleted.md", "vector.md"])
    expect(byKey["vector.md"]?.chunks).toEqual([
      {
        ordinal: 0,
        text: "plain words only",
        startLine: 1,
        endLine: 3,
        distance: expect.any(Number),
      },
    ])
    expect(byKey["vector.md"]?.chunks[0]?.distance).toBeLessThan(0.01)
    // The evidence read gives each status; only the search is active-only.
    expect(byKey["deleted.md"]?.document.status).toBe("deleted")
  })
})

describe("graph view read", () => {
  it("returns the documents and relations of the Workspace, cut at the limit", async () => {
    const all = await store.readGraph(orgA, 1000)
    expect(all.truncated).toBe(false)
    expect(all.documents).toHaveLength(orgADocuments.length)
    expect(all.relations).toHaveLength(6)
    expect(
      all.relations.find((relation) => relation.dstDoc === "lexical.md")
        ?.altText,
    ).toBe("The lexical diagram")
    const cut = await store.readGraph(orgA, 3)
    expect(cut.documents).toHaveLength(3)
    expect(cut.truncated).toBe(true)
  })
})

/** Each read for org A, as text, to look for a row of org B. */
async function readAllForOrgA(
  reader: ReturnType<typeof createKnowledgeStore>,
): Promise<string> {
  const refs = ["vector.md", "lexical.md", "org-b-target.md"].map((docKey) => ({
    workspaceId: workspace,
    docKey,
  }))
  return JSON.stringify([
    await reader.search(orgA, {
      vector: queryVector,
      chunksPerDocument: 2,
      terms: ["zebracorn", "Org", "B"],
      neighbors: { from: 5, places: 10 },
    }),
    await reader.readFrontier(orgA, refs),
    await reader.readDocuments(orgA, refs),
    await reader.readEvidence(orgA, refs, queryVector, 3),
    await reader.readGraph(orgA, 1000),
  ])
}

describe("org isolation of reads", () => {
  it("both walls: no read for org A returns a row of org B", async () => {
    const text = await readAllForOrgA(store)
    expect(text).toContain("plain words only")
    expect(text).not.toContain("Org B")
    expect(text).not.toContain("org-b-target")
    // The same reads for org B see its rows.
    const forB = await store.search(orgB, {
      vector: queryVector,
      chunksPerDocument: 2,
      terms: ["zebracorn"],
    })
    expect(forB.map((hit) => hit.document.title).sort()).toEqual([
      "Org B lexical",
      "Org B target",
      "Org B vector",
    ])
  })

  it("WHERE clause alone: with the row policies removed, no read for org A returns a row of org B", async () => {
    const url = await seededDatabase(async (client) => {
      for (const table of [
        "documents",
        "chunks",
        "relations",
        "relations_in",
        "trees",
      ])
        await client.command({
          query: `DROP ROW POLICY knowledge_org_wall ON ${table}`,
        })
    })
    // Without the policy, a statement for org A sees both orgs.
    const result = await rawClient(url).query({
      query: "SELECT DISTINCT org_id FROM chunks ORDER BY org_id",
      format: "JSONEachRow",
      clickhouse_settings: { [ORG_SETTING]: orgA.orgId },
    })
    expect(await result.json()).toEqual([
      { org_id: orgA.orgId },
      { org_id: orgB.orgId },
    ])
    const reader = createKnowledgeStore(url)
    try {
      const text = await readAllForOrgA(reader)
      expect(text).toContain("plain words only")
      expect(text).not.toContain("Org B")
      expect(text).not.toContain("org-b-target")
    } finally {
      await reader.close()
    }
  })
})
