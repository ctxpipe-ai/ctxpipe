import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"

import {
  type ClickHouseClient,
  ClickHouseLogLevel,
  createClient,
} from "@clickhouse/client"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"

import { contractImage } from "../test/contract-images.js"
import {
  createKnowledgeStore,
  type DocumentRows,
  type KnowledgeScope,
  ORG_SETTING,
} from "./knowledge-store.js"
import { migrateKnowledgeStore } from "./migrate.js"

/*
 * The two org walls of ADR-066 decision 9, against a real ClickHouse of the
 * pinned image. Each test that removes a wall uses its own database, so that
 * the other tests keep both walls.
 *
 * Read walls: (1) the WHERE clause of KnowledgeStore, (2) the row policy.
 * Insert walls: (1) KnowledgeStore sets the org columns, (2) the CHECK
 * constraint. Each wall is proved alone.
 */

const exec = promisify(execFile)
const docker = async (...args: string[]) =>
  (await exec("docker", args, { timeout: 180_000 })).stdout.trim()

const tables = ["documents", "chunks", "relations", "relations_in"] as const
const orgA: KnowledgeScope = { orgId: "org_wall_a", workspaceId: "ws_same" }
// The same Workspace id in both orgs: only the org can separate the rows.
const orgB: KnowledgeScope = { orgId: "org_wall_b", workspaceId: "ws_same" }

let container: string
let serverUrl: string
const clients: ClickHouseClient[] = []

/** A new database with the migrated tables. Returns its URL. */
async function freshDatabase(): Promise<string> {
  const name = `knowledge_${randomUUID().replaceAll("-", "")}`
  const admin = createClient({ url: serverUrl })
  try {
    await admin.command({ query: `CREATE DATABASE ${name}` })
  } finally {
    await admin.close()
  }
  const url = `${serverUrl}/${name}`
  await migrateKnowledgeStore(url)
  return url
}

/** A plain client, for statements that do not go through KnowledgeStore. */
function rawClient(url: string): ClickHouseClient {
  // Quiet: several statements here fail on purpose.
  const client = createClient({ url, log: { level: ClickHouseLogLevel.OFF } })
  clients.push(client)
  return client
}

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
      s3Key: "",
      mime: "",
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      validTo: null,
      observedAt,
    },
    chunks: [
      { ordinal: 0, text: `${title} first section`, embedding: [1, -1, 0.5] },
      { ordinal: 1, text: `${title} second section`, embedding: [-2, 2, 0] },
    ],
    relations: [
      {
        srcChunk: 1,
        predicate: "REFERENCES",
        dstDoc,
        confidence: 0.75,
        validFrom: null,
        validTo: null,
        source: "link",
        observedAt,
      },
    ],
  }
}

/** The document as the store keeps it after a replace. */
const active = (rows: DocumentRows) => ({
  ...rows.document,
  status: "active",
  deletedAt: null,
  error: "",
})

beforeAll(async () => {
  container = `ctxpipe-knowledge-${randomUUID().slice(0, 8)}`
  await docker(
    "run",
    "-d",
    "--name",
    container,
    "-p",
    "127.0.0.1::8123",
    "-e",
    "CLICKHOUSE_USER=knowledge",
    "-e",
    "CLICKHOUSE_PASSWORD=knowledge-test",
    // The migrations create row policies (SQL access management).
    "-e",
    "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1",
    contractImage("clickhouse"),
  )
  const address = (await docker("port", container, "8123/tcp")).split("\n")[0]
  serverUrl = `http://knowledge:knowledge-test@${address}`
  const client = createClient({ url: serverUrl })
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await client.query({ query: "SELECT 1" })
        break
      } catch (error) {
        if (attempt >= 120) throw error
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  } finally {
    await client.close()
  }
}, 240_000)

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()))
  if (container) await docker("rm", "-f", "-v", container).catch(() => "")
})

describe("KnowledgeStore", () => {
  it("fails closed when CLICKHOUSE_URL is not set", () => {
    expect(() => createKnowledgeStore(undefined)).toThrow(/CLICKHOUSE_URL/)
    expect(() => createKnowledgeStore("")).toThrow(/CLICKHOUSE_URL/)
  })

  it("refuses a statement without an org or a Workspace", async () => {
    const store = createKnowledgeStore(serverUrl)
    try {
      await expect(
        store.readDocument({ orgId: "", workspaceId: "ws" }, "a.md"),
      ).rejects.toThrow(/org and a Workspace/)
      const noWorkspace = { orgId: "org", workspaceId: "" }
      for (const mutation of [
        store.replaceDocuments(noWorkspace, [rowsOf("x")]),
        store.markDeleted(noWorkspace, ["x.md"], observedAt),
        store.insertPlaceholders(noWorkspace, [
          { docKey: "x.md", status: "missing", observedAt },
        ]),
        store.listDocumentKeys({ orgId: "", workspaceId: "ws" }),
      ])
        await expect(mutation).rejects.toThrow(/org and a Workspace/)
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
    ])
  })

  it("reads back the document, its chunks and its relations in both directions", async () => {
    const store = createKnowledgeStore(await freshDatabase())
    try {
      const source = rowsOf("Source", "source.md", "target.md")
      const target = rowsOf("Target", "target.md", "other.md")
      await store.replaceDocuments(orgA, [source, target])

      expect(await store.readDocument(orgA, "missing.md")).toBeNull()
      const stored = await store.readDocument(orgA, "target.md")
      expect(stored?.document).toEqual(active(target))
      expect(stored?.chunks).toEqual(target.chunks)
      expect(stored?.outgoing).toEqual([
        { ...target.relations[0], srcDoc: "target.md" },
      ])
      // relations_in, sorted by dst_doc, gives the incoming relations.
      expect(stored?.incoming).toEqual([
        { ...source.relations[0], srcDoc: "source.md" },
      ])
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
          embedding: [1, -1, 1, -1, 0, 0, 0, 0.5, -2, 2, 2, 2, 2, 2, 2, 2, 3],
        },
      ]
      await store.replaceDocuments(orgA, [rows])
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

describe("org isolation of reads", () => {
  let url: string

  beforeAll(async () => {
    url = await freshDatabase()
    const store = createKnowledgeStore(url)
    try {
      await store.replaceDocuments(orgA, [rowsOf("Org A")])
      await store.replaceDocuments(orgB, [rowsOf("Org B")])
    } finally {
      await store.close()
    }
  })

  it("both walls: KnowledgeStore returns only the rows of the org of the scope", async () => {
    const store = createKnowledgeStore(url)
    try {
      const forB = await store.readDocument(orgB, "shared.md")
      expect(forB?.document.title).toBe("Org B")
      expect(forB?.chunks.map((chunk) => chunk.text)).toEqual([
        "Org B first section",
        "Org B second section",
      ])
      expect(forB?.outgoing).toHaveLength(1)
      const forA = await store.readDocument(orgA, "shared.md")
      expect(forA?.document.title).toBe("Org A")
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
      await store.replaceDocuments(orgA, [rowsOf("Org A", "shared.md")])
      await store.replaceDocuments(orgA, [rowsOf("Org A source", "a.md")])
      await store.replaceDocuments(orgB, [rowsOf("Org B", "shared.md")])
      await store.replaceDocuments(orgB, [
        rowsOf("Org B target", "target.md", "other.md"),
      ])
      // Without the policy, a statement for org B sees both orgs.
      const all = await rawRows<{ org_id: string }>(
        client,
        "SELECT DISTINCT org_id FROM documents ORDER BY org_id",
        orgB.orgId,
      )
      expect(all.map((row) => row.org_id)).toEqual([orgA.orgId, orgB.orgId])

      const forB = await store.readDocument(orgB, "shared.md")
      expect(forB?.document.title).toBe("Org B")
      expect(forB?.chunks.map((chunk) => chunk.text)).toEqual([
        "Org B first section",
        "Org B second section",
      ])
      expect(forB?.outgoing.map((relation) => relation.dstDoc)).toEqual([
        "target.md",
      ])
      expect(await store.readDocument(orgB, "a.md")).toBeNull()
      // Org A's shared.md and a.md also point at target.md.
      const target = await store.readDocument(orgB, "target.md")
      expect(target?.document.title).toBe("Org B target")
      expect(target?.incoming.map((relation) => relation.srcDoc)).toEqual([
        "shared.md",
      ])
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
      src_chunk: 0,
      predicate: "REFERENCES",
      dst_doc: "y.md",
      confidence: 1,
      observed_at: "2026-11-19 10:11:12.345",
    }
    const rows = {
      documents: {
        doc_key: "x.md",
        kind: "note",
        status: "active",
        observed_at: "2026-11-19 10:11:12.345",
      },
      chunks: { doc_key: "x.md", ordinal: 0, text: "x", embedding: [1] },
      relations: relationRow,
      relations_in: relationRow,
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
      await store.replaceDocuments(orgA, [rows])
      expect(await store.readDocument(orgB, "shared.md")).toBeNull()
      expect(
        (await store.readDocument(orgA, "shared.md"))?.chunks,
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
      await store.replaceDocuments(orgA, [rowsOf("Org A")])
      await store.replaceDocuments(orgB, [rowsOf("Org B")])
      await rawClient(url).command({
        query: "DELETE FROM documents WHERE doc_key = 'shared.md'",
        clickhouse_settings: { [ORG_SETTING]: orgA.orgId },
      })
      expect(await store.readDocument(orgB, "shared.md")).toBeNull()
    } finally {
      await store.close()
    }
  })
})

/*
 * The users that the migration makes (ADR-066 decision 9), and the mutation
 * API. The mutations run as the writer user of the worker, and the reads as
 * the reader user of the backend. The users are global to the server, so
 * these tests share one database.
 */
describe("users and mutations", () => {
  const passwords = { reader: "reader-test", writer: "writer-test" }
  let adminUrl: string
  let readerUrl: string
  let writerUrl: string
  let reader: ReturnType<typeof createKnowledgeStore>
  let writer: ReturnType<typeof createKnowledgeStore>

  const userUrl = (user: string, password: string) => {
    const url = new URL(adminUrl)
    url.username = user
    url.password = password
    return url.toString()
  }

  /** All rows of a scope in each table, as the admin user reads them. */
  async function snapshot(scope: KnowledgeScope) {
    const client = rawClient(adminUrl)
    const result: Record<string, unknown[]> = {}
    for (const table of tables)
      result[table] = await rawRows(
        client,
        `SELECT * EXCEPT (org_id, workspace_id) FROM ${table}
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
    await writer.replaceDocuments(scope, [rowsOf("Reader", "r.md")])
    expect((await reader.readDocument(scope, "r.md"))?.document.title).toBe(
      "Reader",
    )
    expect(await reader.listDocumentKeys(scope)).toEqual([
      { docKey: "r.md", status: "active" },
    ])

    await expect(
      reader.replaceDocuments(scope, [rowsOf("Changed", "r.md")]),
    ).rejects.toThrow(denied)
    await expect(
      reader.markDeleted(scope, ["r.md"], observedAt),
    ).rejects.toThrow(denied)
    await expect(
      reader.insertPlaceholders(scope, [
        { docKey: "p.md", status: "missing", observedAt },
      ]),
    ).rejects.toThrow(denied)
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
    expect(await reader.readDocument(scope, "r.md")).toMatchObject({
      document: { title: "Reader", status: "active" },
    })
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
      "INSERT INTO knowledge_schema_migrations (name) VALUES ('9999_x.sql')",
    ])
      await expect(client.command({ query }), query).rejects.toThrow(denied)
  })

  it("refuses a reader or writer password that is the admin password", async () => {
    for (const users of [
      { reader: "knowledge-test" },
      { writer: "knowledge-test" },
    ])
      await expect(migrateKnowledgeStore(adminUrl, users)).rejects.toThrow(
        /different from the admin password/,
      )
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
        rawRows(rotated, "SELECT count() AS rows FROM documents", "org_none"),
      ).resolves.toEqual([{ rows: 0 }])
      await expect(
        rotated.command({ query: "DELETE FROM documents WHERE 1" }),
      ).rejects.toThrow(denied)
    } finally {
      // Back to the first password for the other tests.
      await migrateKnowledgeStore(adminUrl, passwords)
    }
  })

  describe("each mutation keeps the org and Workspace scope", () => {
    let run = 0
    let target: KnowledgeScope
    // The same document keys in another Workspace of the same org, and in the
    // same Workspace id of another org.
    let others: KnowledgeScope[]
    let before: Awaited<ReturnType<typeof snapshot>>[]
    const seed = () => [
      rowsOf("Doc", "doc.md", "target.md"),
      rowsOf("Target", "target.md", "doc.md"),
    ]

    beforeEach(async () => {
      run += 1
      target = { orgId: "org_m_a", workspaceId: `ws_m_${run}` }
      others = [
        { orgId: "org_m_a", workspaceId: `ws_m_${run}_other` },
        { orgId: "org_m_b", workspaceId: `ws_m_${run}` },
      ]
      for (const scope of [target, ...others])
        await writer.replaceDocuments(scope, seed())
      before = await Promise.all(others.map(snapshot))
    })

    // Each test changes the target scope only.
    afterEach(async () => {
      expect(await Promise.all(others.map(snapshot))).toEqual(before)
      await expectSameRelations(target)
    })

    it("replaceDocuments replaces the document, its chunks and its outgoing relations", async () => {
      const next = rowsOf("Doc v2", "doc.md", "new-target.md")
      next.chunks = [{ ordinal: 0, text: "only section", embedding: [1] }]
      await writer.replaceDocuments(target, [next])

      const stored = await reader.readDocument(target, "doc.md")
      expect(stored?.document).toEqual(active(next))
      expect(stored?.chunks).toEqual(next.chunks)
      expect(stored?.outgoing).toEqual([
        { ...next.relations[0], srcDoc: "doc.md" },
      ])
      expect(
        (await reader.readDocument(target, "target.md"))?.incoming,
      ).toEqual([])
      // A second run of the same replace (a retry) gives the same rows.
      const once = await snapshot(target)
      await writer.replaceDocuments(target, [next])
      expect(await snapshot(target)).toEqual(once)
    })

    it("markDeleted makes a tombstone and keeps the relations that point at it", async () => {
      const deletedAt = new Date("2026-11-20T08:00:00.123Z")
      await writer.markDeleted(target, ["target.md"], deletedAt)

      const stored = await reader.readDocument(target, "target.md")
      expect(stored?.document).toMatchObject({
        title: "Target",
        status: "deleted",
        deletedAt,
        error: "",
      })
      expect(stored?.chunks).toEqual([])
      expect(stored?.outgoing).toEqual([])
      // doc.md still points at the tombstone.
      expect(stored?.incoming.map((relation) => relation.srcDoc)).toEqual([
        "doc.md",
      ])
      expect((await reader.readDocument(target, "doc.md"))?.incoming).toEqual(
        [],
      )
      expect(await reader.listDocumentKeys(target)).toEqual([
        { docKey: "doc.md", status: "active" },
        { docKey: "target.md", status: "deleted" },
      ])
      // A retry keeps the date of the first deletion.
      await writer.markDeleted(target, ["target.md"], observedAt)
      expect(
        (await reader.readDocument(target, "target.md"))?.document.deletedAt,
      ).toEqual(deletedAt)
      // A key with no row: a retry after a failure between the DELETE and
      // the INSERT of a tombstone still makes the tombstone.
      await writer.markDeleted(target, ["gone.md"], deletedAt)
      expect(
        (await reader.readDocument(target, "gone.md"))?.document,
      ).toMatchObject({ status: "deleted", deletedAt, title: "", kind: "" })
      // The file comes back: a replace makes the row active again.
      await writer.replaceDocuments(target, seed())
      expect(
        (await reader.readDocument(target, "target.md"))?.document.status,
      ).toBe("active")
    })

    it("insertPlaceholders replaces each document with a missing or failed row", async () => {
      await writer.insertPlaceholders(target, [
        { docKey: "nowhere.md", status: "missing", observedAt },
        {
          docKey: "doc.md",
          status: "failed",
          error: "parse error",
          observedAt,
        },
      ])
      expect(await reader.listDocumentKeys(target)).toEqual([
        { docKey: "doc.md", status: "failed" },
        { docKey: "nowhere.md", status: "missing" },
        { docKey: "target.md", status: "active" },
      ])
      const failed = await reader.readDocument(target, "doc.md")
      expect(failed?.document).toMatchObject({
        status: "failed",
        error: "parse error",
        title: "",
      })
      expect(failed?.chunks).toEqual([])
      expect(failed?.outgoing).toEqual([])
      expect(
        (await reader.readDocument(target, "nowhere.md"))?.document,
      ).toMatchObject({ status: "missing", error: "", deletedAt: null })
    })

    it("a missing placeholder does not replace a document or a tombstone", async () => {
      const deletedAt = new Date("2026-11-20T08:00:00.123Z")
      await writer.markDeleted(target, ["gone.md"], deletedAt)
      const before = await snapshot(target)
      await writer.insertPlaceholders(target, [
        { docKey: "target.md", status: "missing", observedAt },
        { docKey: "gone.md", status: "missing", observedAt },
      ])
      expect(await snapshot(target)).toEqual(before)
      expect(
        (await reader.readDocument(target, "gone.md"))?.document,
      ).toMatchObject({ status: "deleted", deletedAt })
    })

    it("a document key cannot change the predicates of a statement", async () => {
      const injected = "x') OR (1 = 1"
      await writer.markDeleted(target, [injected], observedAt)
      await writer.insertPlaceholders(target, [
        { docKey: injected, status: "missing", observedAt },
      ])
      await writer.replaceDocuments(target, [rowsOf("Injected", injected)])
      expect(await reader.listDocumentKeys(target)).toEqual([
        { docKey: "doc.md", status: "active" },
        { docKey: "target.md", status: "active" },
        { docKey: injected, status: "active" },
      ])
    })

    it("refuses a batch with the same document key two times", async () => {
      const unchanged = await snapshot(target)
      await expect(
        writer.replaceDocuments(target, [
          rowsOf("A", "doc.md"),
          rowsOf("B", "doc.md"),
        ]),
      ).rejects.toThrow(/two times/)
      await expect(
        writer.insertPlaceholders(target, [
          { docKey: "new.md", status: "missing", observedAt },
          { docKey: "new.md", status: "missing", observedAt },
        ]),
      ).rejects.toThrow(/two times/)
      expect(await snapshot(target)).toEqual(unchanged)
    })
  })

  // The proof that the API cannot make a DELETE without both predicates: the
  // server logs the text of each statement that the tests above sent as the
  // writer user.
  it("each DELETE of the writer has the org and Workspace predicates first, and the writer sends no other change", async () => {
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
      new Set(["Delete"]),
    )
    for (const { query } of statements)
      expect(query).toMatch(
        /^DELETE FROM \w+ WHERE \(org_id = '\w+'\) AND \(workspace_id = '\w+'\) AND \(/,
      )
  })
})
