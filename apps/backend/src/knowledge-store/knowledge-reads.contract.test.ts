import type { ClickHouseClient } from "@clickhouse/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { startClickHouse, userUrl } from "../test/clickhouse.js"
import {
  createKnowledgeStore,
  type DocumentRows,
  type FileRelation,
  type KnowledgeReadScope,
  type KnowledgeScope,
  type KnowledgeStore,
  ORG_SETTING,
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

/** The rows of a document, and the `valid_from` of its tree row. */
type Seeded = DocumentRows & { validFrom: Date | null }

function document(
  docKey: string,
  chunks: { text: string; embedding: number[] }[],
  options: Partial<DocumentRows["document"]> & {
    validFrom?: Date | null
    relations?: Partial<FileRelation>[]
  } = {},
): Seeded {
  const { relations = [], validFrom = null, ...fields } = options
  return {
    validFrom,
    document: {
      docKey,
      kind: "note",
      title: docKey,
      path: `notes/${docKey}`,
      sourceType: "git",
      source: "workspace",
      summary: "",
      mime: "",
      validTo: null,
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
const orgADocuments: Seeded[] = [
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
  // Close vector and the query term, valid in 2020 only.
  document("old.md", [{ text: "zebracorn of 2020", embedding: nearQuery(7) }], {
    // A file of the Linear mirror.
    path: "linear/old.md",
    validFrom: new Date("2020-01-01T00:00:00.000Z"),
    validTo: new Date("2021-01-01T00:00:00.000Z"),
    relations: [{ dstDoc: "vector.md" }],
  }),
  document(
    "guides/setup.md",
    [{ text: "setup guide", embedding: nearQuery(3) }],
    {
      kind: "guide",
      path: "guides/setup.md",
      observedAt: new Date("2026-11-20T00:00:00.000Z"),
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
        ...(i === 3 ? { validFrom: new Date("2030-01-01T00:00:00.000Z") } : {}),
      },
    ),
  ),
]

/** Org B: the same Workspace id and keys, other text. */
const orgBDocuments: Seeded[] = [
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
const entryOf = (rows: Seeded, version: string): TreeEntry => ({
  docKey: rows.document.docKey,
  version,
  path: rows.document.path,
  status: "active",
  kind: rows.document.kind,
  observedAt: rows.document.observedAt,
  validFrom: rows.validFrom,
  validTo: rows.document.validTo,
  deletedAt: null,
})

/**
 * Writes the file version `version` of each of `documents`, and its tree row
 * of `main` with the tree version `treeVersion`.
 */
async function seed(
  store: KnowledgeStore,
  scope: KnowledgeScope,
  documents: Seeded[],
  { version = "v1", treeVersion = 1 } = {},
): Promise<void> {
  await store.writeFileVersions(
    scope,
    documents.map(({ validFrom: _validFrom, ...rows }) => ({
      ...rows,
      version,
    })),
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
    { chunks = 1, title = "" }: { chunks?: number; title?: string } = {},
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
      title,
      vector,
    }
    const docKey = `concat({prefix:String}, leftPad(toString(number), 5, '0'), '.md')`
    await client.command({
      query: `INSERT INTO documents (org_id, workspace_id, doc_key, version,
          kind, status, title, path, observed_at)
        SELECT {orgId:String}, {workspace:String}, ${docKey}, 'v1',
          {kind:String}, 'active', {title:String}, '', now64(3)
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

let store: ReturnType<typeof createKnowledgeStore>

beforeAll(async () => {
  clickHouse = await startClickHouse()
  // The backend reads as the reader user, with SELECT only. Only this
  // database gets the users: their grants name the tables of one database.
  const url = await seededDatabase()
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

  it("lexical: the cap of each term applies after the filters", async () => {
    // 1200 chunks of excluded documents sort before the one chunk that the
    // filter allows, and all have the term. 600 allowed chunks are nearer
    // to the query vector, so only the lexical part can find it.
    const url = await clickHouse.freshDatabase()
    const fill = filler(url)
    await fill("note", "a-excluded-", 1200, "capword", opposite)
    await fill("guide", "m-near-", 600, "near", queryVector)
    await fill("guide", "z-target-", 1, "capword", opposite)
    const reader = createKnowledgeStore(url)
    const scope = { ...orgA, heads: [{ ...head, treeVersion: 1 }] }
    try {
      const hits = await reader.search(scope, {
        vector: queryVector,
        terms: ["capword"],
        kinds: ["guide"],
        chunksPerDocument: 2,
      })
      expect(hitKeys(hits)).toContain("z-target-00000.md")
      // Without the term, the vector part alone does not find it.
      expect(
        hitKeys(
          await reader.search(scope, {
            vector: queryVector,
            terms: [],
            kinds: ["guide"],
            chunksPerDocument: 2,
          }),
        ),
      ).not.toContain("z-target-00000.md")
    } finally {
      await reader.close()
    }
  })

  it("the top 50 is 50 documents: a document with many close chunks takes one place", async () => {
    // One document has 60 chunks at the query vector. 60 documents have one
    // chunk each, farther away. A cut at 50 chunks would give only the long
    // document.
    const url = await clickHouse.freshDatabase()
    const fill = filler(url)
    await fill("guide", "a-long-", 1, "long text", queryVector, { chunks: 60 })
    await fill("guide", "m-short-", 60, "short text", nearQuery(1))
    const reader = createKnowledgeStore(url)
    const scope = { ...orgA, heads: [{ ...head, treeVersion: 1 }] }
    try {
      const hits = await reader.search(scope, {
        vector: queryVector,
        terms: [],
        chunksPerDocument: 2,
      })
      expect(hits).toHaveLength(50)
      expect(hits[0]?.document.docKey).toBe("a-long-00000.md")
      // The hit keeps its best chunks, at most `chunksPerDocument`.
      expect(hits[0]?.chunks).toHaveLength(2)
      expect(new Set(hitKeys(hits)).size).toBe(50)
    } finally {
      await reader.close()
    }
  })

  it("lexical: a rare query term weighs more than common ones", async () => {
    // 60 documents match the two common terms, and one document matches
    // only the rare term. All chunks have the same vector, and the rare
    // document sorts last by key, so only the term weight can lift it into
    // the top 50.
    const url = await clickHouse.freshDatabase()
    const fill = filler(url)
    await fill("guide", "a-common-", 60, "the plan of record", queryVector)
    await fill("guide", "z-rare-", 1, "zebracorn", queryVector)
    const reader = createKnowledgeStore(url)
    const scope = { ...orgA, heads: [{ ...head, treeVersion: 1 }] }
    try {
      const hits = await reader.search(scope, {
        vector: queryVector,
        terms: ["the", "of", "zebracorn"],
        chunksPerDocument: 2,
      })
      expect(hitKeys(hits)).toContain("z-rare-00000.md")
    } finally {
      await reader.close()
    }
  })

  it("never finds a deleted document", async () => {
    const keys = hitKeys(await search({ terms: ["zebracorn", "deleted"] }))
    expect(keys).not.toContain("deleted.md")
    expect(keys).toContain("lexical.md")
  })

  it("validAt: finds a document only in its validity", async () => {
    expect(hitKeys(await search({ terms: ["zebracorn"] }))).toContain("old.md")
    const in2020 = hitKeys(
      await search({ terms: ["zebracorn"], validAt: new Date("2020-06-01") }),
    )
    expect(in2020).toContain("old.md")
    // A document with no validity is valid at each time.
    expect(in2020).toContain("lexical.md")
    expect(
      hitKeys(
        await search({ terms: ["zebracorn"], validAt: new Date("2026-06-01") }),
      ),
    ).not.toContain("old.md")
  })

  it("filters by kind and by path prefix", async () => {
    expect(hitKeys(await search({ kinds: ["guide"] }))).toEqual([
      "guides/setup.md",
    ])
    expect(hitKeys(await search({ pathPrefix: "guides/" }))).toEqual([
      "guides/setup.md",
    ])
  })

  it("filters by source and by the time a document was observed", async () => {
    // The source is the mirror root of the path, else authored.
    expect(
      hitKeys(await search({ terms: ["zebracorn"], sources: ["linear"] })),
    ).toEqual(["old.md"])
    expect(
      hitKeys(await search({ terms: ["zebracorn"], sources: ["authored"] })),
    ).not.toContain("old.md")
    expect(
      hitKeys(
        await search({ observedAfter: new Date("2026-11-19T12:00:00.000Z") }),
      ),
    ).toEqual(["guides/setup.md"])
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

  it("gives each document the status, the deletion time and the valid_from of its tree row", async () => {
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
    expect(old?.document.validFrom).toEqual(
      new Date("2020-01-01T00:00:00.000Z"),
    )
  })
})

describe("frontier relations", () => {
  const frontier = (validAt?: Date) =>
    store.readFrontier(
      orgA,
      [{ workspaceId: workspace, docKey: "vector.md" }],
      validAt,
    )

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
    // The claim of filler-03 has the `valid_from` of its tree row.
    expect(
      relations.find((row) => row.relation.srcDoc === "filler-03.md")?.relation
        .validFrom,
    ).toEqual(new Date("2030-01-01T00:00:00.000Z"))
    expect(relations[1]?.neighbor).toEqual({
      ...orgADocuments[1]?.document,
      status: "active",
      deletedAt: null,
      error: "",
      validFrom: null,
    })
  })

  it("validAt: leaves out a relation or a neighbor that is not valid at that time", async () => {
    const in2026 = await frontier(new Date("2026-06-01"))
    expect(in2026.map((row) => row.relation.srcDoc)).toEqual([
      "vector.md",
      "vector.md",
      "filler-01.md",
    ])
    const in2020 = await frontier(new Date("2020-06-01"))
    expect(in2020.map((row) => row.relation.srcDoc)).toEqual([
      "vector.md",
      "vector.md",
      "filler-01.md",
      "filler-02.md",
      "old.md",
    ])
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
