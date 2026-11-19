import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"

import {
  type ClickHouseClient,
  ClickHouseLogLevel,
  createClient,
} from "@clickhouse/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

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

const tables = ["documents", "chunks", "relations"] as const
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

function rowsOf(
  title: string,
  docKey = "shared.md",
  dstDoc = "target.md",
): DocumentRows {
  return {
    document: {
      docKey,
      kind: "note",
      status: "active",
      deletedAt: null,
      error: "",
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
      await expect(
        store.insertDocument({ orgId: "org", workspaceId: "" }, rowsOf("x")),
      ).rejects.toThrow(/org and a Workspace/)
    } finally {
      await store.close()
    }
  })

  it("applies each migration one time", async () => {
    const url = await freshDatabase()
    expect(await migrateKnowledgeStore(url)).toEqual([])
    const applied = await rawRows<{ name: string }>(
      rawClient(url),
      "SELECT name FROM knowledge_schema_migrations",
    )
    expect(applied).toEqual([{ name: "0001_knowledge_tables.sql" }])
  })

  it("reads back the document, its chunks and its relations in both directions", async () => {
    const store = createKnowledgeStore(await freshDatabase())
    try {
      const source = rowsOf("Source", "source.md", "target.md")
      const target = rowsOf("Target", "target.md", "other.md")
      await store.insertDocument(orgA, source)
      await store.insertDocument(orgA, target)

      expect(await store.readDocument(orgA, "missing.md")).toBeNull()
      const stored = await store.readDocument(orgA, "target.md")
      expect(stored?.document).toEqual(target.document)
      expect(stored?.chunks).toEqual(target.chunks)
      expect(stored?.outgoing).toEqual([
        { ...target.relations[0], srcDoc: "target.md" },
      ])
      // The projection sorted by dst_doc gives the incoming relations.
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
      await store.insertDocument(orgA, rows)
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
      await store.insertDocument(orgA, rowsOf("Org A"))
      await store.insertDocument(orgB, rowsOf("Org B"))
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
    // The read of the incoming relations, through the projection by_dst.
    const incoming = await rawRows<{ org_id: string }>(
      client,
      "SELECT org_id FROM relations WHERE dst_doc = 'target.md'",
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
      await store.insertDocument(orgA, rowsOf("Org A", "shared.md"))
      await store.insertDocument(orgA, rowsOf("Org A source", "a.md"))
      await store.insertDocument(orgB, rowsOf("Org B", "shared.md"))
      await store.insertDocument(
        orgB,
        rowsOf("Org B target", "target.md", "other.md"),
      )
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
    const rows = {
      documents: {
        doc_key: "x.md",
        kind: "note",
        status: "active",
        observed_at: "2026-11-19 10:11:12.345",
      },
      chunks: { doc_key: "x.md", ordinal: 0, text: "x", embedding: [1] },
      relations: {
        src_doc: "x.md",
        src_chunk: 0,
        predicate: "REFERENCES",
        dst_doc: "y.md",
        confidence: 1,
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

  it("KnowledgeStore alone: with the constraints removed, a row that carries org B is stored for the org of the scope", async () => {
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
      await store.insertDocument(orgA, rows)
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

describe("known gap: the row policy does not filter changes", () => {
  // ADR-066 decision 9 and the review of CTX-1392: a ClickHouse row policy
  // filters reads only. A lightweight DELETE or UPDATE has one wall, the org
  // and the Workspace in its WHERE clause. This test fails when ClickHouse
  // starts to apply the policy to changes, so that the ADR can change.
  it("a DELETE for org A without the org in its WHERE clause deletes rows of org B", async () => {
    const url = await freshDatabase()
    const store = createKnowledgeStore(url)
    try {
      await store.insertDocument(orgA, rowsOf("Org A"))
      await store.insertDocument(orgB, rowsOf("Org B"))
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
