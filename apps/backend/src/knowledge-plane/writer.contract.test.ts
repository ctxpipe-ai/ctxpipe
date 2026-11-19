import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { type ClickHouseClient, createClient } from "@clickhouse/client"
import { config } from "dotenv"
import { and, eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
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

import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { knowledgeState } from "../db/schema/knowledge_state.js"
import { workspaces } from "../db/schema/workspaces.js"
import { servingIdForKnowledgePath } from "../domain/workspaces/hydrate.js"
import {
  createKnowledgeStore,
  type KnowledgeStore,
  ORG_SETTING,
} from "../knowledge-store/knowledge-store.js"
import { migrateKnowledgeStore } from "../knowledge-store/migrate.js"
import { getKnowledgeState } from "../models/knowledge-state.js"
import { createLogger, withLogger } from "../observability/logger.js"
import { multimodalEmbeddingConfig } from "../retrieval/embeddings/multimodalEmbeddings.js"
import { startClickHouse, userUrl } from "../test/clickhouse.js"
import { projectKnowledgePlane } from "./writer.js"

/*
 * The projection writer of ADR-067 against real collaborators: a real Git
 * remote (`file://`), Postgres (`knowledge_state`), and ClickHouse of the
 * pinned image as the writer user. msw answers the embedding API.
 */

const here = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(here, "../../.env.local"), quiet: true })

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_kwriter_${suffix}`
const observedAt = new Date("2026-11-19T10:11:12.345Z")
const tables = ["documents", "chunks", "relations", "relations_in"] as const
const EMBEDDINGS_URL = "https://embeddings.test/api/v1/embeddings"

/** A vector that only the text of the input decides. */
function vectorOf(content: unknown): number[] {
  const digest = createHash("sha256").update(JSON.stringify(content)).digest()
  return Array.from(
    { length: multimodalEmbeddingConfig.dimensions },
    (_, i) => ((digest[i % digest.length] ?? 0) - 128) / 64,
  )
}

/** The embedding requests; `failAt` answers that request (1-based) with a 400. */
const embeddings = { requests: 0, failAt: 0 }
const msw = setupServer(
  http.post(EMBEDDINGS_URL, async ({ request }) => {
    embeddings.requests++
    if (embeddings.requests === embeddings.failAt)
      return HttpResponse.json({ error: "down" }, { status: 400 })
    const body = (await request.json()) as {
      input: { content: unknown }[]
    }
    return HttpResponse.json({
      data: body.input.map((input, index) => ({
        index,
        embedding: vectorOf(input.content),
      })),
    })
  }),
)

let stopClickHouse: (() => Promise<void>) | undefined
let admin: ClickHouseClient
let store: KnowledgeStore
const workspaceIds: string[] = []

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Knowledge writer",
    createdAt: new Date(),
  })
  msw.listen({ onUnhandledRequest: "bypass" })
  const clickhouse = await startClickHouse()
  stopClickHouse = clickhouse.stop
  const adminUrl = await clickhouse.freshDatabase()
  // The writer user of the worker (ADR-066 decision 9).
  await migrateKnowledgeStore(adminUrl, {
    reader: "reader-test",
    writer: "writer-test",
  })
  admin = createClient({ url: adminUrl })
  store = createKnowledgeStore(
    userUrl(adminUrl, "ctxpipe_writer", "writer-test"),
  )
}, 240_000)

afterAll(async () => {
  msw.close()
  await store?.close()
  await admin?.close()
  await stopClickHouse?.()
  for (const workspaceId of workspaceIds)
    await withOrgDbContext(orgId, (db) =>
      db.delete(workspaces).where(eq(workspaces.id, workspaceId)),
    )
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeDb()
})

beforeEach(() => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", "https://embeddings.test/api/v1")
  embeddings.requests = 0
  embeddings.failAt = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** A Workspace row in Postgres, for `knowledge_state`. */
async function newWorkspace(): Promise<string> {
  const workspaceId = `ws_test_kwriter_${workspaceIds.length}_${suffix}`
  workspaceIds.push(workspaceId)
  await withOrgDbContext(orgId, (db) =>
    db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      slug: workspaceId.replaceAll("_", "-"),
      displayName: "Knowledge writer",
      workspaceRepositoryUrl: `https://github.com/example/${workspaceId}.git`,
      desiredDefaultBranch: "main",
    }),
  )
  return workspaceId
}

/** A Git repository that a shallow fetch by SHA can read. */
class Remote {
  private constructor(readonly directory: string) {}

  static async create(): Promise<Remote> {
    const remote = new Remote(
      await mkdtemp(join(tmpdir(), "knowledge-writer-")),
    )
    remote.git("init", "-q", "-b", "main")
    remote.git("config", "uploadpack.allowAnySHA1InWant", "true")
    return remote
  }

  get url(): string {
    return pathToFileURL(this.directory).toString()
  }

  git(...args: string[]): string {
    return execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "-C",
        this.directory,
        ...args,
      ],
      { encoding: "utf8" },
    ).trim()
  }

  /** Write (text or bytes) or remove (null) each file, commit, and give the SHA. */
  async commit(files: Record<string, string | Buffer | null>): Promise<string> {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) this.git("rm", "-q", "--cached", path)
      else {
        await mkdir(dirname(join(this.directory, path)), { recursive: true })
        await writeFile(join(this.directory, path), content)
        this.git("add", path)
      }
    }
    this.git("commit", "-q", "--allow-empty", "-m", "change")
    return this.git("rev-parse", "HEAD")
  }

  async remove(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true })
  }
}

function run(
  remote: Remote,
  workspaceId: string,
  tip: string,
  options: { store?: KnowledgeStore; root?: string } = {},
) {
  // The hydrate workflow gives the writer its logger.
  return withLogger(createLogger({}), () =>
    projectKnowledgePlane({
      orgId,
      workspaceId,
      remote: { url: remote.url, token: async () => undefined },
      root: options.root ?? "",
      tip,
      store: options.store ?? store,
      observedAt,
    }),
  )
}

type Row = Record<string, unknown>
type Table = (typeof tables)[number]

/** All rows of a Workspace in each table, as the admin user reads them. */
async function snapshot(workspaceId: string): Promise<Record<Table, Row[]>> {
  const result = {} as Record<Table, Row[]>
  for (const table of tables)
    result[table] = await (
      await admin.query({
        query: `SELECT * EXCEPT (org_id, workspace_id) FROM ${table}
                WHERE org_id = {orgId:String} AND workspace_id = {workspaceId:String}
                ORDER BY ALL`,
        query_params: { orgId, workspaceId },
        format: "JSONEachRow",
        clickhouse_settings: { [ORG_SETTING]: orgId },
      })
    ).json<Row>()
  return result
}

/**
 * The rows with content, with each key of `workspaceId` written as its path:
 * the documents that are `active` or `failed`, and all chunks and relations.
 * A tombstone and a `missing` placeholder have no content. A Workspace that
 * applied a history keeps a tombstone for each removed file, and a new
 * Workspace has none, so `empty` lists them apart.
 */
async function content(workspaceId: string, paths: string[]) {
  const pathOf = new Map(
    paths.map((path) => [servingIdForKnowledgePath(workspaceId, path), path]),
  )
  const named = (key: unknown) => {
    const path = pathOf.get(String(key))
    if (path === undefined) throw new Error(`No path for the key ${key}`)
    return path
  }
  const rows = await snapshot(workspaceId)
  const hasContent = (row: Row) =>
    row.status === "active" || row.status === "failed"
  const result = {} as Record<Table, Row[]>
  for (const table of tables)
    result[table] = rows[table]
      .filter((row) => table !== "documents" || hasContent(row))
      .map((row) => {
        const out: Row = { ...row }
        for (const column of ["doc_key", "src_doc", "dst_doc"])
          if (column in out) out[column] = named(out[column])
        if ("s3_key" in out)
          out.s3_key = String(out.s3_key).replace(workspaceId, "{workspace}")
        return out
      })
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return {
    ...result,
    /** The paths whose document has no content. */
    empty: rows.documents
      .filter((row) => !hasContent(row))
      .map((row) => named(row.doc_key))
      .sort(),
  }
}

async function statusOf(workspaceId: string) {
  return Object.fromEntries(
    (await store.listDocumentKeys({ orgId, workspaceId })).map((row) => [
      row.docKey,
      row.status,
    ]),
  )
}

/** Each row of the documents table: its key and its status. */
async function keysOf(workspaceId: string) {
  return (await store.listDocumentKeys({ orgId, workspaceId }))
    .map(({ docKey, status }) => [docKey, status])
    .sort()
}

/**
 * A store whose `markDeleted` stops after the INSERT of the tombstones, as a
 * worker that dies there: the tombstone and the old row both stay.
 */
function halfTombstones(workspaceId: string): KnowledgeStore {
  return {
    ...store,
    markDeleted: async (_scope, docKeys, deletedAt) => {
      await admin.command({
        query: `INSERT INTO documents
                SELECT * REPLACE ('deleted' AS status,
                  parseDateTime64BestEffort({deletedAt:String}, 3, 'UTC') AS deleted_at)
                FROM documents
                WHERE org_id = {orgId:String} AND workspace_id = {workspaceId:String}
                  AND doc_key IN {docKeys:Array(String)}`,
        query_params: {
          orgId,
          workspaceId,
          docKeys,
          deletedAt: deletedAt.toISOString(),
        },
        clickhouse_settings: { [ORG_SETTING]: orgId },
      })
      throw new Error("crash after the tombstone INSERT")
    },
  }
}

const key = (workspaceId: string, path: string) =>
  servingIdForKnowledgePath(workspaceId, path)

const png = (seed: string) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(seed)])

/** A real history: each commit exercises one rule of ADR-067. */
async function writeHistory(remote: Remote): Promise<string[]> {
  const shas: string[] = []
  // A link to a file that does not exist yet, an image, a source claim
  // (no source file), and a file that is not knowledge.
  shas.push(
    await remote.commit({
      "a.md": [
        "---",
        "title: Alpha",
        "sources:",
        "  - sources/repo.md",
        "---",
        "# Alpha",
        "See [B](b.md) and ![diagram](img/d.png).",
      ].join("\n"),
      "notes/c.md": "# Gamma\n\nSee ![d](../img/d.png) and [alpha](../a.md).\n",
      "img/d.png": png("one"),
      // An image that no file shows, and an image that a later commit removes.
      "img/unused.png": png("unused"),
      "img/old.png": png("old"),
      "AGENTS.md": "# Agents\n",
    }),
  )
  // The link target appears; the image bytes change.
  shas.push(
    await remote.commit({
      "b.md": "# Beta\n\nBack to [alpha](a.md).\n",
      "img/d.png": png("two"),
    }),
  )
  // A file that does not parse, and a change of a file.
  shas.push(
    await remote.commit({
      "e.md": "---\ntitle: broken\n",
      "notes/c.md": "# Gamma\n\nNow without the image. See [alpha](../a.md).\n",
      "img/old.png": null,
    }),
  )
  // The broken file is fixed; a rename (a removal and an addition).
  shas.push(
    await remote.commit({
      "e.md": "---\ntitle: Epsilon\n---\n# Epsilon\n\nSee [g](g.md).\n",
      "f.md": "# Phi\n",
    }),
  )
  remote.git("mv", "f.md", "g.md")
  shas.push(await remote.commit({}))
  // A submodule gitlink is not a regular file.
  remote.git(
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${shas[0]},vendor/lib`,
  )
  shas.push(await remote.commit({}))
  // A removed file whose document other files point at.
  shas.push(await remote.commit({ "b.md": null }))
  return shas
}

const historyPaths = [
  "a.md",
  "b.md",
  "notes/c.md",
  "e.md",
  "f.md",
  "g.md",
  "img/d.png",
  "img/unused.png",
  "img/old.png",
  "sources/repo.md",
  "AGENTS.md",
]

describe("projectKnowledgePlane", () => {
  it("applied commit by commit, gives the same tables as a full rebuild at the tip", async () => {
    const remote = await Remote.create()
    try {
      const shas = await writeHistory(remote)
      const tip = shas.at(-1) ?? ""
      const stepwise = await newWorkspace()
      for (const sha of shas) await run(remote, stepwise, sha)
      const rebuilt = await newWorkspace()
      expect(await run(remote, rebuilt, tip)).toMatchObject({
        mode: "full",
        fullReason: "first_run",
      })

      const left = await content(stepwise, historyPaths)
      const right = await content(rebuilt, historyPaths)
      expect(left.documents.map((row) => row.doc_key).sort()).toEqual([
        "a.md",
        "e.md",
        "g.md",
        "img/d.png",
        "img/unused.png",
        "notes/c.md",
      ])
      for (const table of [...tables])
        expect(left[table], table).toEqual(right[table])
      // A link target with no content has a row in both: a tombstone after
      // the history, a `missing` placeholder after the rebuild.
      expect(left.empty).toEqual([
        "b.md",
        "f.md",
        "img/old.png",
        "sources/repo.md",
      ])
      expect(right.empty).toEqual(["b.md", "sources/repo.md"])
      expect(await statusOf(stepwise)).toMatchObject({
        [key(stepwise, "b.md")]: "deleted",
        [key(stepwise, "f.md")]: "deleted",
        [key(stepwise, "img/old.png")]: "deleted",
        [key(stepwise, "sources/repo.md")]: "missing",
      })

      // A full rebuild on top of the history changes no row of any table.
      const before = await snapshot(stepwise)
      await withOrgDbContext(orgId, (db) =>
        db
          .delete(knowledgeState)
          .where(
            and(
              eq(knowledgeState.organizationId, orgId),
              eq(knowledgeState.workspaceId, stepwise),
            ),
          ),
      )
      expect(await run(remote, stepwise, tip)).toMatchObject({ mode: "full" })
      expect(await snapshot(stepwise)).toEqual(before)
    } finally {
      await remote.remove()
    }
  })

  it("after a crash at a random point, a retry gives the same tables, also when a later commit changes a file back", async () => {
    for (let round = 0; round < 6; round++) {
      const remote = await Remote.create()
      try {
        const aOne = "# Alpha\n\nSee [b](b.md).\n"
        const base = await remote.commit({
          "a.md": aOne,
          "b.md": "# Beta\n",
          "img/d.png": png("one"),
          "c.md": "# Gamma\n\n![d](img/d.png)\n",
        })
        // The failed run changes each kind of row.
        const failedTip = await remote.commit({
          "a.md": "# Alpha two\n\nSee [x](x.md).\n",
          "b.md": null,
          "img/d.png": png("two"),
          "n.md": "# New\n\nSee [a](a.md).\n",
        })
        // The next commit changes a.md and the image back.
        const tip = await remote.commit({
          "a.md": aOne,
          "img/d.png": png("one"),
        })

        const workspaceId = await newWorkspace()
        await run(remote, workspaceId, base)
        // Crash at a random store call (before or after its write lands), or
        // at the embedding request. The run makes four store calls.
        const crash = round % 3 === 2 ? "embeddings" : "store"
        const after = round % 3 === 1
        let calls = 0
        const failAt = 1 + Math.floor(Math.random() * 4)
        const crashing: KnowledgeStore = {
          ...store,
          ...Object.fromEntries(
            (
              ["replaceDocuments", "markDeleted", "insertPlaceholders"] as const
            ).map((name) => [
              name,
              async (...args: never[]) => {
                const fail = crash === "store" && ++calls === failAt
                if (fail && !after) throw new Error("crash before the write")
                await (store[name] as (...a: never[]) => Promise<void>)(...args)
                if (fail) throw new Error("crash after the write")
              },
            ]),
          ),
        }
        if (crash === "embeddings") embeddings.failAt = embeddings.requests + 1
        const crashed = await run(remote, workspaceId, failedTip, {
          store: crashing,
        }).then(
          () => false,
          () => true,
        )
        embeddings.failAt = 0
        const point = `round ${round}: ${crash} call ${failAt}`
        expect(crashed, point).toBe(true)
        expect(await getKnowledgeState({ orgId, workspaceId })).toMatchObject({
          lastSha: base,
          attemptShas: [failedTip],
          runStatus: "failed",
        })

        expect(await run(remote, workspaceId, tip)).toMatchObject({
          mode: "delta",
        })
        expect(await getKnowledgeState({ orgId, workspaceId })).toMatchObject({
          lastSha: tip,
          attemptShas: [],
          runStatus: "completed",
        })
        const rebuilt = await newWorkspace()
        await run(remote, rebuilt, tip)
        const paths = ["a.md", "b.md", "c.md", "n.md", "x.md", "img/d.png"]
        const left = await content(workspaceId, paths)
        const right = await content(rebuilt, paths)
        for (const table of [...tables])
          expect(left[table], `${point}, ${table}`).toEqual(right[table])
      } finally {
        await remote.remove()
      }
    }
  })

  it("a retry ends a tombstone that a crash left between its INSERT and the DELETE of the old row", async () => {
    const remote = await Remote.create()
    try {
      const workspaceId = await newWorkspace()
      const scope = { orgId, workspaceId }
      const base = await remote.commit({
        "a.md": "# Alpha\n\nSee [b](b.md) and ![e](img/e.png).\n",
        "b.md": "# Beta\n",
        "img/e.png": png("e"),
      })
      await run(remote, workspaceId, base)
      const tip = await remote.commit({ "b.md": null, "img/e.png": null })
      await expect(
        run(remote, workspaceId, tip, { store: halfTombstones(workspaceId) }),
      ).rejects.toThrow("crash after the tombstone INSERT")
      expect(await keysOf(workspaceId)).toEqual(
        [
          [key(workspaceId, "a.md"), "active"],
          [key(workspaceId, "b.md"), "active"],
          [key(workspaceId, "b.md"), "deleted"],
          [key(workspaceId, "img/e.png"), "active"],
          [key(workspaceId, "img/e.png"), "deleted"],
        ].sort(),
      )

      await run(remote, workspaceId, tip)
      expect(await keysOf(workspaceId)).toEqual(
        [
          [key(workspaceId, "a.md"), "active"],
          [key(workspaceId, "b.md"), "deleted"],
          [key(workspaceId, "img/e.png"), "deleted"],
        ].sort(),
      )
      const tombstone = await store.readDocument(
        scope,
        key(workspaceId, "b.md"),
      )
      expect(tombstone?.document).toMatchObject({
        title: "Beta",
        path: "b.md",
        deletedAt: observedAt,
      })
      // The relation of a.md still points at the tombstone.
      expect(tombstone?.incoming).toHaveLength(1)
    } finally {
      await remote.remove()
    }
  })

  it("a full rebuild after a missing commit makes the documents of removed files tombstones", async () => {
    const remote = await Remote.create()
    try {
      const old = await remote.commit({
        "a.md": "# Alpha\n",
        "b.md": "# Beta\n",
      })
      const workspaceId = await newWorkspace()
      await run(remote, workspaceId, old)
      expect(await statusOf(workspaceId)).toEqual({
        [key(workspaceId, "a.md")]: "active",
        [key(workspaceId, "b.md")]: "active",
      })

      // A force-push to a new history, then a Git GC: `last_sha` is gone.
      remote.git("checkout", "-q", "--orphan", "rewritten")
      remote.git("rm", "-q", "-r", "--cached", ".")
      const tip = await remote.commit({ "a.md": "# Alpha rewritten\n" })
      remote.git("branch", "-D", "main")
      remote.git("reflog", "expire", "--expire=now", "--all")
      remote.git("gc", "-q", "--prune=now")
      expect(() => remote.git("cat-file", "-e", old)).toThrow()

      // The first attempt stops in the reconcile, between the INSERT of the
      // tombstone and the DELETE of the old row.
      await expect(
        run(remote, workspaceId, tip, { store: halfTombstones(workspaceId) }),
      ).rejects.toThrow("crash after the tombstone INSERT")
      expect(await run(remote, workspaceId, tip)).toMatchObject({
        mode: "full",
        fullReason: "missing_commit",
      })
      expect(await keysOf(workspaceId)).toEqual(
        [
          [key(workspaceId, "a.md"), "active"],
          [key(workspaceId, "b.md"), "deleted"],
        ].sort(),
      )
      expect(
        (
          await store.readDocument(
            { orgId, workspaceId },
            key(workspaceId, "b.md"),
          )
        )?.document.title,
      ).toBe("Beta")
      expect(
        (
          await store.readDocument(
            { orgId, workspaceId },
            key(workspaceId, "b.md"),
          )
        )?.document.deletedAt,
      ).toEqual(observedAt)
    } finally {
      await remote.remove()
    }
  })

  it("moves documents and the run state through the status lifecycle", async () => {
    const remote = await Remote.create()
    try {
      const workspaceId = await newWorkspace()
      const scope = { orgId, workspaceId }
      const b = key(workspaceId, "b.md")
      const e = key(workspaceId, "e.md")

      // missing: a link target that Git does not have.
      const one = await remote.commit({
        "a.md": "# Alpha\n\nSee [b](b.md).\n",
        "e.md": "---\ntitle: broken\n",
      })
      expect(await run(remote, workspaceId, one)).toMatchObject({
        mode: "full",
        failedCount: 1,
      })
      expect(await statusOf(workspaceId)).toMatchObject({
        [b]: "missing",
        [e]: "failed",
      })
      expect((await store.readDocument(scope, e))?.document.error).toBe(
        "malformed",
      )
      expect(await getKnowledgeState(scope)).toMatchObject({
        lastSha: one,
        runStatus: "completed",
        failedCount: 1,
      })
      // A run at the same tip does nothing.
      expect(await run(remote, workspaceId, one)).toEqual({ mode: "current" })

      // missing → active, failed → active.
      const two = await remote.commit({
        "b.md": "# Beta\n",
        "e.md": "# Epsilon\n",
      })
      expect(await run(remote, workspaceId, two)).toMatchObject({
        mode: "delta",
        failedCount: 0,
      })
      expect(await statusOf(workspaceId)).toMatchObject({
        [b]: "active",
        [e]: "active",
      })

      // active → deleted: the relation of a.md stays.
      const three = await remote.commit({ "b.md": null })
      await run(remote, workspaceId, three)
      const tombstone = await store.readDocument(scope, b)
      expect(tombstone?.document).toMatchObject({
        status: "deleted",
        title: "Beta",
        deletedAt: observedAt,
      })
      expect(tombstone?.incoming.map((relation) => relation.srcDoc)).toEqual([
        key(workspaceId, "a.md"),
      ])

      // A failed run: the state keeps `last_sha`, and adds the tip.
      const four = await remote.commit({ "b.md": "# Beta again\n" })
      embeddings.failAt = embeddings.requests + 1
      await expect(run(remote, workspaceId, four)).rejects.toThrow(
        /Embedding request failed: HTTP 400/,
      )
      expect(await getKnowledgeState(scope)).toMatchObject({
        lastSha: three,
        attemptShas: [four],
        runStatus: "failed",
      })

      // deleted → active, and the relation of a.md works at once.
      await run(remote, workspaceId, four)
      const back = await store.readDocument(scope, b)
      expect(back?.document).toMatchObject({
        status: "active",
        deletedAt: null,
        title: "Beta again",
      })
      expect(back?.incoming).toHaveLength(1)
      expect(await getKnowledgeState(scope)).toMatchObject({
        lastSha: four,
        attemptShas: [],
        runStatus: "completed",
      })
    } finally {
      await remote.remove()
    }
  })

  it("writes an image file with the hash in its S3 key, skips submodules, and reads only the root folder", async () => {
    const remote = await Remote.create()
    try {
      const workspaceId = await newWorkspace()
      const scope = { orgId, workspaceId }
      const tip = await remote.commit({
        "docs/a.md": "# Alpha\n\n![d](img/d.png)\n",
        "docs/img/d.png": png("one"),
        "outside.md": "# Outside\n",
      })
      await run(remote, workspaceId, tip, { root: "docs" })
      const image = await store.readDocument(
        scope,
        key(workspaceId, "img/d.png"),
      )
      const hash = createHash("sha256").update(png("one")).digest("hex")
      expect(image?.document).toMatchObject({
        kind: "image",
        status: "active",
        path: "img/d.png",
        mime: "image/png",
        s3Key: `${orgId}/${workspaceId}/${hash}`,
      })
      // No image bytes yet, so no image embedding.
      expect(image?.chunks).toEqual([
        { ordinal: 0, text: "", startLine: 0, endLine: 0, embedding: [] },
      ])
      // A chunk of a knowledge file keeps the lines that the mapper gives.
      expect(
        (await store.readDocument(scope, key(workspaceId, "a.md")))?.chunks.map(
          ({ startLine, endLine }) => ({ startLine, endLine }),
        ),
      ).toEqual([{ startLine: 1, endLine: 3 }])
      expect(image?.incoming.map((relation) => relation.predicate)).toEqual([
        "EMBEDS_IMAGE",
      ])
      expect(Object.keys(await statusOf(workspaceId)).sort()).toEqual(
        [key(workspaceId, "a.md"), key(workspaceId, "img/d.png")].sort(),
      )
    } finally {
      await remote.remove()
    }
  })
})
