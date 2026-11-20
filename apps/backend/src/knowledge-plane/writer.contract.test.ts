import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { type ClickHouseClient, createClient } from "@clickhouse/client"
import { config } from "dotenv"
import { and, eq } from "drizzle-orm"
import { bypass, HttpResponse, http, passthrough } from "msw"
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
import { stringify } from "yaml"

import { recordSpans } from "../../test/spans.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { knowledgeState } from "../db/schema/knowledge_state.js"
import { workspaces } from "../db/schema/workspaces.js"
import { servingIdForKnowledgePath } from "../domain/workspaces/hydrate.js"
import {
  createKnowledgeStore,
  type KnowledgeStore,
  ORG_SETTING,
  REFERENCE_TARGET_PREFIX,
} from "../knowledge-store/knowledge-store.js"
import { migrateKnowledgeStore } from "../knowledge-store/migrate.js"
import { getKnowledgeState } from "../models/knowledge-state.js"
import { createLogger, withLogger } from "../observability/logger.js"
import { multimodalEmbeddingConfig } from "../retrieval/embeddings/multimodalEmbeddings.js"
import { renderGithubPullRequest } from "../services/github/pull-request-mirror/converter.js"
import { renderLinearIssue } from "../services/linear/converter.js"
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
const tables = [
  "documents",
  "chunks",
  "relations",
  "relations_in",
  "doc_refs",
] as const
const EMBEDDINGS_URL = "https://embeddings.test/api/v1/embeddings"

/**
 * A vector that only the text of the input decides. Most of its values are
 * not BFloat16 values, so the stored vector is not the vector of the answer.
 */
function vectorOf(content: unknown): number[] {
  const digest = createHash("sha256").update(JSON.stringify(content)).digest()
  return Array.from(
    { length: multimodalEmbeddingConfig.dimensions },
    (_, i) => ((digest[i % digest.length] ?? 0) - 128) / 100,
  )
}

/**
 * The embedding requests; `failAt` answers that request (1-based) with a 401,
 * an error that fails the run. A 400 is a refusal of the content.
 * `inputs` holds the content parts of each request.
 */
const embeddings = {
  requests: 0,
  failAt: 0,
  inputs: [] as { content: unknown }[][],
  /** A request that holds this text (an image in base64) gets a 400. */
  refuse: null as string | null,
}
const msw = setupServer(
  http.post(EMBEDDINGS_URL, async ({ request }) => {
    embeddings.requests++
    if (embeddings.requests === embeddings.failAt)
      return HttpResponse.json({ error: "down" }, { status: 401 })
    const body = (await request.json()) as {
      input: { content: unknown }[]
    }
    if (embeddings.refuse && JSON.stringify(body).includes(embeddings.refuse))
      return HttpResponse.json({ error: "bad image" }, { status: 400 })
    embeddings.inputs.push(body.input)
    return HttpResponse.json({
      data: body.input.map((input, index) => ({
        index,
        embedding: vectorOf(input.content),
      })),
    })
  }),
  // The statements to ClickHouse: see `fault`.
  http.post("*", async ({ request }) => {
    if (!clickHouseOrigin || new URL(request.url).origin !== clickHouseOrigin)
      return undefined
    // An INSERT sends its statement in the URL, and the others in the body.
    const statement = (
      new URL(request.url).searchParams.get("query") ??
      (await request.clone().text())
    ).trim()
    const fail =
      fault.match.test(statement) && ++fault.statements === fault.failAt
    // Without a content length, the client waits for the end of the body
    // until its timeout.
    const error = "Code: 1000. DB::Exception: the worker crashed"
    const crash = () =>
      new HttpResponse(error, {
        status: 500,
        headers: { "content-length": String(error.length) },
      })
    if (fail && !fault.after) return crash()
    if (!fail) {
      // A DELETE that the server refuses fails the run, so each DELETE
      // before the crash got a success.
      if (statement.startsWith("DELETE")) fault.deletes++
      return passthrough()
    }
    // Send the statement, wait until ClickHouse applied it, then crash.
    // fetch refuses the transfer-encoding header of the client.
    const headers = new Headers(request.headers)
    headers.delete("transfer-encoding")
    const applied = await fetch(
      bypass(request.url, {
        method: "POST",
        headers,
        body: await request.clone().arrayBuffer(),
      }),
    )
    await applied.arrayBuffer()
    if (!applied.ok) throw new Error(`ClickHouse refused: ${statement}`)
    return crash()
  }),
)

/**
 * The statements to ClickHouse. The statement `failAt` (1-based) of those
 * whose text matches `match` fails, as a worker that dies there: before it
 * gets to ClickHouse, or with `after`, when ClickHouse applied it. With
 * `failAt` 0, no statement fails. `deletes` counts the DELETEs that got a
 * success, so not the DELETE that fails after ClickHouse applied it.
 */
const fault = {
  match: /./,
  failAt: 0,
  after: false,
  statements: 0,
  deletes: 0,
}
let clickHouseOrigin: string | undefined

const spans = recordSpans()
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
  clickHouseOrigin = new URL(adminUrl).origin
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
  embeddings.inputs = []
  embeddings.refuse = null
  Object.assign(fault, {
    match: /./,
    failAt: 0,
    after: false,
    statements: 0,
    deletes: 0,
  })
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

/**
 * A Git repository that a shallow fetch by SHA can read, and a fetch with no
 * blobs too. Each commit is one day after the commit before it, so each
 * commit has its own time.
 */
class Remote {
  private commits = 0

  private constructor(readonly directory: string) {}

  /** The committer time of the commit `index` (from 0). */
  static timeOf(index: number): Date {
    return new Date(Date.UTC(2026, 0, 1 + index))
  }

  static async create(): Promise<Remote> {
    const remote = new Remote(
      await mkdtemp(join(tmpdir(), "knowledge-writer-")),
    )
    remote.git("init", "-q", "-b", "main")
    remote.git("config", "uploadpack.allowAnySHA1InWant", "true")
    remote.git("config", "uploadpack.allowFilter", "true")
    return remote
  }

  get url(): string {
    return pathToFileURL(this.directory).toString()
  }

  git(...args: string[]): string {
    const date = `@${Remote.timeOf(this.commits).getTime() / 1000} +0000`
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
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      },
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
    this.commits++
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
        query: `SELECT * EXCEPT (org_id, workspace_id, written_at) FROM ${table}
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
    // A reference key target stays as it is.
    if (String(key).startsWith(REFERENCE_TARGET_PREFIX)) return String(key)
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

/** The `valid_from` of a row (UTC with no zone in JSON), as an ISO time. */
function validFromAt(row: Row): string | null {
  return row.valid_from === null
    ? null
    : new Date(`${String(row.valid_from)}Z`).toISOString()
}

/** The `valid_from` of each document with content, by path. */
function validFromOf(rows: Awaited<ReturnType<typeof content>>) {
  return Object.fromEntries(
    rows.documents.map((row) => [String(row.doc_key), validFromAt(row)]),
  )
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
 * The writer store, with a crash before the first DELETE of a run: after
 * the INSERT of the tombstones, the tombstone and the old row both stay.
 */
function halfTombstones(): KnowledgeStore {
  Object.assign(fault, {
    match: /^DELETE/,
    failAt: 1,
    after: false,
    statements: 0,
  })
  return store
}

const key = (workspaceId: string, path: string) =>
  servingIdForKnowledgePath(workspaceId, path)

/** A PNG header (400 × 300 px), then `seed`, so that each seed gives other bytes. */
const png = (seed: string) => {
  const header = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header)
  header.writeUInt32BE(13, 8)
  header.write("IHDR", 12, "ascii")
  header.writeUInt32BE(400, 16)
  header.writeUInt32BE(300, 20)
  return Buffer.concat([header, Buffer.from(seed)])
}

/** A JPEG header (400 × 300 px): a JFIF segment, then the frame size. */
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01,
  0x2c, 0x01, 0x90, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xd9,
])

/** A Linear issue mirror file, as the Linear sync writes it. */
function linearIssue(identifier: string, description = "") {
  return renderLinearIssue({
    id: `issue-${identifier}`,
    identifier,
    title: `Issue ${identifier}`,
    url: `https://linear.app/acme/issue/${identifier}/issue`,
    priorityLabel: "No priority",
    teamKey: identifier.split("-")[0] ?? "",
    labels: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    comments: [],
    attachments: [],
    description,
  })
}

const MERGED_AT = "2026-09-01T10:00:00.000Z"

/** A merged pull request mirror file of acme/shop, as the GitHub sync writes it. */
function mergedPull(number: number, body: string, files: string[] = []) {
  return renderGithubPullRequest({
    id: number,
    number,
    repository: "acme/shop",
    url: `https://github.com/acme/shop/pull/${number}`,
    title: `Change ${number}`,
    body,
    state: "closed",
    merged: true,
    mergedAt: MERGED_AT,
    draft: false,
    author: { login: "dev", type: "human" },
    base: { ref: "main", sha: "a".repeat(40) },
    head: { ref: "change", sha: "b".repeat(40) },
    reviewDecision: null,
    labels: [],
    requestedReviewers: [],
    createdAt: "2026-08-30T10:00:00Z",
    updatedAt: MERGED_AT,
    files: files.map((path) => ({ path, status: "modified" as const })),
    reviews: [],
    comments: [],
    requiredChecks: [],
  })
}

/** The GitHub source file of acme/shop (ADR-050). */
const SHOP_SOURCE = {
  path: "sources/github/acme/shop.md",
  content:
    "---\nprovider: github\nconnection: con_github1\nrepository: acme/shop\n---\n",
}

/** A unit that the extract wrote for acme/shop: a package or the Repository. */
function shopUnit(kind: string, root?: string) {
  return `---\n${stringify({
    kind,
    generated_by: "ctxpipe-extract",
    sources: [SHOP_SOURCE.path],
    ...(root === undefined ? {} : { root }),
  })}---\n# ${kind}\n`
}

const historyIssue = linearIssue("ENG-1")
const historyPull = mergedPull(42, "Fixes ENG-1.", ["apps/api/src/checkout.ts"])

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
      // A merged pull request that names a Linear issue and changes a
      // package: neither target file exists yet.
      [historyPull.path]: historyPull.content,
      [SHOP_SOURCE.path]: SHOP_SOURCE.content,
    }),
  )
  // The link target appears; the image bytes change. The reference key
  // targets appear in a delta, with no change to the pull request file.
  shas.push(
    await remote.commit({
      "b.md": "# Beta\n\nBack to [alpha](a.md).\n",
      "img/d.png": png("two"),
      [historyIssue.path]: historyIssue.content,
      "knowledge/services/api.md": shopUnit("Service", "apps/api"),
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
  historyIssue.path,
  historyPull.path,
  SHOP_SOURCE.path,
  "knowledge/services/api.md",
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
      expect(left.documents.map((row) => row.doc_key).sort()).toEqual(
        [
          "a.md",
          "e.md",
          "g.md",
          "img/d.png",
          "img/unused.png",
          "notes/c.md",
          historyIssue.path,
          historyPull.path,
          SHOP_SOURCE.path,
          "knowledge/services/api.md",
        ].sort(),
      )
      // The keys of the mirror and package files, and the key relations of
      // the pull request.
      expect(left.doc_refs).toEqual(
        expect.arrayContaining([
          { ref_key: "iss:linear:ENG-1", doc_key: historyIssue.path },
          {
            ref_key: "changed:https://github.com/acme/shop#apps/api",
            doc_key: "knowledge/services/api.md",
          },
        ]),
      )
      expect(
        left.relations
          .filter((row) => row.src_doc === historyPull.path)
          .map((row) => [row.predicate, row.dst_doc]),
      ).toEqual(
        expect.arrayContaining([
          ["LINKS_TO", "ref:iss:linear:ENG-1"],
          ["CHANGED", "ref:changed:https://github.com/acme/shop#apps/api"],
        ]),
      )
      for (const table of [...tables])
        expect(left[table], table).toEqual(right[table])
      // A document gets the time of the commit that introduced its file. A
      // change of the file keeps it; a rename is a new file. An image gets
      // none.
      const time = (index: number) => Remote.timeOf(index).toISOString()
      expect(validFromOf(right)).toEqual({
        "a.md": time(0),
        "notes/c.md": time(0),
        [historyPull.path]: time(0),
        [SHOP_SOURCE.path]: time(0),
        [historyIssue.path]: time(1),
        "knowledge/services/api.md": time(1),
        "e.md": time(2),
        "g.md": time(4),
        "img/d.png": null,
        "img/unused.png": null,
      })
      // A claim with no time of its own gets the same time.
      expect(
        right.relations
          .filter(
            (row) => row.src_doc === "a.md" && row.predicate === "FROM_SOURCE",
          )
          .map(validFromAt),
      ).toEqual([time(0)])
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

  it("a run over several commits, forward or back, gives the valid_from of a full rebuild, also to a file that a commit removed and a later commit added again", async () => {
    const remote = await Remote.create()
    try {
      const base = await remote.commit({ "x.md": "# X\n", "y.md": "# Y\n" })
      const workspaceId = await newWorkspace()
      await run(remote, workspaceId, base)
      await remote.commit({ "x.md": null })
      // The tip tree has x.md as at `base`, so the diff does not show it.
      const tip = await remote.commit({
        "x.md": "# X\n",
        "y.md": "# Y changed\n",
      })
      expect(await run(remote, workspaceId, tip)).toMatchObject({
        mode: "delta",
      })
      const rebuilt = await newWorkspace()
      await run(remote, rebuilt, tip)

      const paths = ["x.md", "y.md"]
      const left = await content(workspaceId, paths)
      expect(left).toEqual(await content(rebuilt, paths))
      expect(validFromOf(left)).toEqual({
        "x.md": Remote.timeOf(2).toISOString(),
        "y.md": Remote.timeOf(0).toISOString(),
      })

      // The tip goes back to `base`, where x.md has its first introducing
      // commit. The diff shows only y.md.
      expect(await run(remote, workspaceId, base)).toMatchObject({
        mode: "delta",
      })
      const back = await newWorkspace()
      await run(remote, back, base)
      const reset = await content(workspaceId, paths)
      expect(reset).toEqual(await content(back, paths))
      expect(validFromOf(reset)).toEqual({
        "x.md": Remote.timeOf(0).toISOString(),
        "y.md": Remote.timeOf(0).toISOString(),
      })
    } finally {
      await remote.remove()
    }
  })

  it("after a crash at each write statement, a retry gives the same tables, also when a later commit changes a file back", async () => {
    /** A Workspace at the base commit, and the commits after it. */
    const issue = linearIssue("ENG-7")
    const scenario = async (remote: Remote) => {
      const aOne = "# Alpha\n\nSee [b](b.md).\n"
      const base = await remote.commit({
        "a.md": aOne,
        "b.md": "# Beta\n",
        "img/d.png": png("one"),
        "c.md": "# Gamma\n\n![d](img/d.png)\n",
        [issue.path]: issue.content,
      })
      // The failed run changes each kind of row.
      const failedTip = await remote.commit({
        "a.md": "# Alpha two\n\nSee [x](x.md).\n",
        "b.md": null,
        "img/d.png": png("two"),
        "n.md": "# New\n\nSee [a](a.md).\n",
        [issue.path]: linearIssue("ENG-7", "Changed").content,
      })
      // The next commit changes a.md and the image back.
      const tip = await remote.commit({
        "a.md": aOne,
        "img/d.png": png("one"),
      })
      const workspaceId = await newWorkspace()
      await run(remote, workspaceId, base)
      return { base, failedTip, tip, workspaceId }
    }
    const writes = /^(INSERT|DELETE)/

    // Count the INSERTs and DELETEs of the failed run.
    const counted = await Remote.create()
    try {
      const { failedTip, workspaceId } = await scenario(counted)
      Object.assign(fault, { match: writes, failAt: 0, statements: 0 })
      await run(counted, workspaceId, failedTip)
    } finally {
      await counted.remove()
    }
    const statements = fault.statements
    expect(statements).toBeGreaterThan(5)

    // The embedding request, then each write statement: before ClickHouse
    // gets it, and after ClickHouse applied it.
    const points = [
      { at: 0, after: false },
      ...Array.from({ length: statements }, (_, index) => [
        { at: index + 1, after: false },
        { at: index + 1, after: true },
      ]).flat(),
    ]
    for (const { at, after } of points) {
      const remote = await Remote.create()
      try {
        const { base, failedTip, tip, workspaceId } = await scenario(remote)
        if (at === 0) embeddings.failAt = embeddings.requests + 1
        else Object.assign(fault, { match: writes, failAt: at, after })
        Object.assign(fault, { statements: 0, deletes: 0 })
        const crashed = await run(remote, workspaceId, failedTip).then(
          () => false,
          () => true,
        )
        embeddings.failAt = 0
        fault.failAt = 0
        const point =
          at === 0
            ? "the embedding request"
            : `write ${at} of ${statements}, ${after ? "after" : "before"} it`
        expect(crashed, point).toBe(true)
        // The failed run reports the DELETEs that ClickHouse applied.
        expect(
          spans.spanNamed("knowledge.projection.apply")?.attributes,
          point,
        ).toMatchObject({
          "ctxpipe.knowledge.outcome": "failed",
          "ctxpipe.knowledge.mutations": fault.deletes,
        })
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
        const paths = [
          "a.md",
          "b.md",
          "c.md",
          issue.path,
          "n.md",
          "x.md",
          "img/d.png",
        ]
        const left = await content(workspaceId, paths)
        const right = await content(rebuilt, paths)
        for (const table of [...tables])
          expect(left[table], `${point}, ${table}`).toEqual(right[table])
        // The file of b.md is gone: its key keeps one row, a tombstone.
        expect(
          (await keysOf(workspaceId)).filter(
            ([docKey]) => docKey === key(workspaceId, "b.md"),
          ),
          point,
        ).toEqual([[key(workspaceId, "b.md"), "deleted"]])
      } finally {
        await remote.remove()
      }
    }
  }, 600_000)

  it("deletes the rows of a run of 200 changed documents with at most one DELETE for each table", async () => {
    const remote = await Remote.create()
    try {
      const files = (version: string) =>
        Object.fromEntries(
          Array.from({ length: 200 }, (_, index) =>
            index < 10
              ? (({ path, content }) => [path, content])(
                  linearIssue(`ENG-${index}`, version),
                )
              : [
                  `doc-${index}.md`,
                  `# Doc ${index} ${version}\n\nSee [next](doc-${index + 1}.md).\n`,
                ],
          ),
        )
      const workspaceId = await newWorkspace()
      await run(remote, workspaceId, await remote.commit(files("one")))
      const tip = await remote.commit(files("two"))

      // ClickHouse lists each mutation, with the Workspace in its command.
      const mutations = async () =>
        Object.fromEntries(
          (
            await (
              await admin.query({
                query: `SELECT table, count() AS count FROM system.mutations
                        WHERE database = currentDatabase()
                          AND position(command, {workspaceId:String}) > 0
                        GROUP BY table`,
                query_params: { workspaceId },
                format: "JSONEachRow",
              })
            ).json<{ table: string; count: number }>()
          ).map(({ table, count }) => [table, count]),
        )
      const before = await mutations()
      expect(await run(remote, workspaceId, tip)).toMatchObject({
        mode: "delta",
        documentsChanged: 200,
      })
      const after = await mutations()
      expect(
        Object.fromEntries(
          tables.map((table) => [
            table,
            (after[table] ?? 0) - (before[table] ?? 0),
          ]),
        ),
      ).toEqual(Object.fromEntries(tables.map((table) => [table, 1])))
      expect(
        spans.spanNamed("knowledge.projection.apply")?.attributes,
      ).toMatchObject({
        "ctxpipe.knowledge.outcome": "completed",
        "ctxpipe.knowledge.mutations": 5,
      })
    } finally {
      await remote.remove()
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
        run(remote, workspaceId, tip, { store: halfTombstones() }),
      ).rejects.toThrow("the worker crashed")
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
        run(remote, workspaceId, tip, { store: halfTombstones() }),
      ).rejects.toThrow("the worker crashed")
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
        /Embedding request failed: HTTP 401/,
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

  it("embeds the bytes of an image file, keeps no copy of them, skips submodules, and reads only the root folder", async () => {
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
      expect(image?.document).toMatchObject({
        kind: "image",
        status: "active",
        path: "img/d.png",
        mime: "image/png",
      })
      // The image chunk has no text. Its vector comes from a request that
      // holds the bytes of the image only.
      const dataUri = `data:image/png;base64,${png("one").toString("base64")}`
      expect(embeddings.inputs).toContainEqual([
        { content: [{ type: "image_url", image_url: { url: dataUri } }] },
      ])
      expect(image?.chunks).toMatchObject([
        { ordinal: 0, text: "", startLine: 0, endLine: 0 },
      ])
      expect(image?.chunks[0]?.embedding).toHaveLength(
        multimodalEmbeddingConfig.dimensions,
      )
      // The alt text of the reference is on its relation.
      expect(
        image?.incoming.map(({ predicate, altText }) => ({
          predicate,
          altText,
        })),
      ).toEqual([{ predicate: "EMBEDS_IMAGE", altText: "d" }])
      // A chunk of a knowledge file keeps the lines that the mapper gives.
      expect(
        (await store.readDocument(scope, key(workspaceId, "a.md")))?.chunks.map(
          ({ startLine, endLine }) => ({ startLine, endLine }),
        ),
      ).toEqual([{ startLine: 1, endLine: 3 }])
      expect(Object.keys(await statusOf(workspaceId)).sort()).toEqual(
        [key(workspaceId, "a.md"), key(workspaceId, "img/d.png")].sort(),
      )
    } finally {
      await remote.remove()
    }
  })

  it("gives a failed document to an image that the model does not take, and completes the run", async () => {
    const remote = await Remote.create()
    try {
      const workspaceId = await newWorkspace()
      const scope = { orgId, workspaceId }
      const large = Buffer.alloc(multimodalEmbeddingConfig.maxImageBytes + 1)
      png("large").copy(large)
      const tip = await remote.commit({
        "a.md":
          "# Alpha\n\n![Logo](logo.svg) ![Big](big.png) ![Fake](fake.png) ![Photo](p.jpg) ![Chart](chart.png)\n",
        "logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
        "big.png": large,
        "fake.png": "This is text, not a PNG.",
        "p.jpg": jpeg,
        "chart.png": png("chart"),
      })
      const summary = await run(remote, workspaceId, tip)
      expect(summary).toMatchObject({ mode: "full", failedCount: 3 })
      expect((await getKnowledgeState({ orgId, workspaceId }))?.lastSha).toBe(
        tip,
      )
      const documentOf = async (path: string) =>
        (await store.readDocument(scope, key(workspaceId, path)))?.document
      expect(await documentOf("logo.svg")).toMatchObject({
        status: "failed",
        error:
          "The embedding model does not take images of type image/svg+xml.",
      })
      expect(await documentOf("big.png")).toMatchObject({
        status: "failed",
        error: expect.stringContaining("The embedding model takes at most"),
      })
      // The type comes from the bytes, not from the file name.
      expect(await documentOf("fake.png")).toMatchObject({
        status: "failed",
        error: "The bytes are not an image of type image/png.",
      })
      expect(await documentOf("p.jpg")).toMatchObject({
        status: "active",
        mime: "image/jpeg",
      })
      // Only the JPEG and the small PNG go to the embedding model, one in
      // each request. Each relation stays, with its alt text.
      const imageInputs = embeddings.inputs.filter((input) =>
        JSON.stringify(input).includes("image_url"),
      )
      expect(imageInputs).toEqual(
        expect.arrayContaining(
          [
            `data:image/png;base64,${png("chart").toString("base64")}`,
            `data:image/jpeg;base64,${jpeg.toString("base64")}`,
          ].map((url) => [
            { content: [{ type: "image_url", image_url: { url } }] },
          ]),
        ),
      )
      expect(imageInputs).toHaveLength(2)
      expect(
        (await store.readDocument(scope, key(workspaceId, "a.md")))?.outgoing
          .map(({ dstDoc, altText }) => [dstDoc, altText])
          .sort(),
      ).toEqual(
        [
          [key(workspaceId, "logo.svg"), "Logo"],
          [key(workspaceId, "big.png"), "Big"],
          [key(workspaceId, "fake.png"), "Fake"],
          [key(workspaceId, "p.jpg"), "Photo"],
          [key(workspaceId, "chart.png"), "Chart"],
        ].sort(),
      )
    } finally {
      await remote.remove()
    }
  })
})

/**
 * The frontier read of the file at `path`: each relation as its direction,
 * its predicate, the path of the neighbor (the key of a `missing` key
 * target) and the status of the neighbor.
 */
async function frontierOf(workspaceId: string, path: string) {
  const relations = await store.readFrontier(
    { orgId, workspaceIds: [workspaceId] },
    [{ workspaceId, docKey: key(workspaceId, path) }],
  )
  return relations
    .map(({ direction, relation, neighbor }) => ({
      direction,
      predicate: relation.predicate,
      neighbor: neighbor?.path || neighbor?.docKey,
      status: neighbor?.status,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

describe("reference keys (CTX-1400)", () => {
  const issue = linearIssue("ENG-1")
  const pull = mergedPull(
    7,
    "Fixes ENG-1. See https://linear.app/acme/issue/ENG-1/issue.",
  )
  /** The relation of the pull request to the issue, from both ends. */
  const resolved = [
    {
      direction: "out",
      predicate: "LINKS_TO",
      neighbor: issue.path,
      status: "active",
    },
  ]

  it("a link from a pull request file to a Linear issue file resolves through the keys of the issue file", async () => {
    const remote = await Remote.create()
    try {
      const workspaceId = await newWorkspace()
      // A second file that states the same key: the read gives both.
      const copy = { ...issue, path: "linear/teams/OPS/issues/ENG-1.md" }
      await run(
        remote,
        workspaceId,
        await remote.commit({
          [pull.path]: pull.content,
          [issue.path]: issue.content,
          [copy.path]: copy.content,
        }),
      )
      // The identifier and the URL name the same file: one relation.
      expect(await frontierOf(workspaceId, pull.path)).toEqual([
        { ...resolved[0], neighbor: issue.path },
        { ...resolved[0], neighbor: copy.path },
      ])
      expect(await frontierOf(workspaceId, issue.path)).toEqual([
        {
          direction: "in",
          predicate: "LINKS_TO",
          neighbor: pull.path,
          status: "active",
        },
      ])
      const graph = await store.readGraph({ orgId, workspaceId }, 100)
      expect(
        graph.relations
          .filter((relation) => relation.srcDoc === key(workspaceId, pull.path))
          .map((relation) => relation.dstDoc)
          .sort(),
      ).toEqual(
        [key(workspaceId, issue.path), key(workspaceId, copy.path)].sort(),
      )
    } finally {
      await remote.remove()
    }
  })

  it("a link resolves when the target file comes after the source file, with no change to the source", async () => {
    const remote = await Remote.create()
    try {
      const workspaceId = await newWorkspace()
      await run(
        remote,
        workspaceId,
        await remote.commit({ [pull.path]: pull.content }),
      )
      // A key with no document is a `missing` target, and the store keeps
      // no placeholder row for it.
      expect(await frontierOf(workspaceId, pull.path)).toEqual([
        {
          direction: "out",
          predicate: "LINKS_TO",
          neighbor: "ref:iss:linear:ENG-1",
          status: "missing",
        },
        {
          direction: "out",
          predicate: "LINKS_TO",
          neighbor: "ref:iss:linear:ENG-1@acme",
          status: "missing",
        },
      ])
      expect(Object.keys(await statusOf(workspaceId))).toEqual([
        key(workspaceId, pull.path),
      ])

      const before = await store.readDocument(
        { orgId, workspaceId },
        key(workspaceId, pull.path),
      )
      expect(
        await run(
          remote,
          workspaceId,
          await remote.commit({ [issue.path]: issue.content }),
        ),
      ).toMatchObject({ mode: "delta", documentsChanged: 1 })
      expect(
        await store.readDocument(
          { orgId, workspaceId },
          key(workspaceId, pull.path),
        ),
      ).toEqual(before)
      expect(await frontierOf(workspaceId, pull.path)).toEqual(resolved)
    } finally {
      await remote.remove()
    }
  })

  it("when the target file goes away, the link becomes missing", async () => {
    const remote = await Remote.create()
    try {
      const workspaceId = await newWorkspace()
      await run(
        remote,
        workspaceId,
        await remote.commit({
          [pull.path]: pull.content,
          [issue.path]: issue.content,
        }),
      )
      expect(await frontierOf(workspaceId, pull.path)).toEqual(resolved)

      await run(
        remote,
        workspaceId,
        await remote.commit({ [issue.path]: null }),
      )
      expect(await frontierOf(workspaceId, pull.path)).toEqual([
        {
          direction: "out",
          predicate: "LINKS_TO",
          neighbor: "ref:iss:linear:ENG-1",
          status: "missing",
        },
        {
          direction: "out",
          predicate: "LINKS_TO",
          neighbor: "ref:iss:linear:ENG-1@acme",
          status: "missing",
        },
      ])
      // The tombstone of the issue file states no key.
      expect(
        (
          await store.readDocument(
            { orgId, workspaceId },
            key(workspaceId, issue.path),
          )
        )?.refKeys,
      ).toEqual([])
    } finally {
      await remote.remove()
    }
  })

  it("a CHANGED claim of a merged pull request resolves to the package file whose root holds a changed file, and to the Repository file", async () => {
    const remote = await Remote.create()
    try {
      const workspaceId = await newWorkspace()
      const changes = mergedPull(8, "", ["apps/api/src/checkout.ts"])
      await run(
        remote,
        workspaceId,
        await remote.commit({
          [SHOP_SOURCE.path]: SHOP_SOURCE.content,
          "knowledge/services/api.md": shopUnit("Service", "apps/api"),
          "knowledge/apps/web.md": shopUnit("App", "apps/web"),
          "knowledge/codebases/shop.md": shopUnit("Repository"),
          [changes.path]: changes.content,
        }),
      )
      const relations = await store.readFrontier(
        { orgId, workspaceIds: [workspaceId] },
        [{ workspaceId, docKey: key(workspaceId, changes.path) }],
      )
      expect(
        relations
          .filter(({ relation }) => relation.predicate === "CHANGED")
          .filter(({ neighbor }) => neighbor?.status === "active")
          .map(({ relation, neighbor }) => [
            neighbor?.path,
            relation.validFrom?.toISOString(),
          ])
          .sort(),
      ).toEqual([
        ["knowledge/codebases/shop.md", MERGED_AT],
        ["knowledge/services/api.md", MERGED_AT],
      ])
      expect(
        (await frontierOf(workspaceId, "knowledge/services/api.md")).filter(
          (relation) => relation.direction === "in",
        ),
      ).toEqual([
        {
          direction: "in",
          predicate: "CHANGED",
          neighbor: changes.path,
          status: "active",
        },
      ])
    } finally {
      await remote.remove()
    }
  })

  it("gives a failed document to an image that the model refuses, and embeds the other images", async () => {
    const remote = await Remote.create()
    try {
      const workspaceId = await newWorkspace()
      const scope = { orgId, workspaceId }
      // A cut file: its header is good, and the model refuses its bytes.
      embeddings.refuse = png("cut").toString("base64")
      const tip = await remote.commit({
        "a.md": "# Alpha\n\n![A](a.png) ![Cut](cut.png) ![Z](z.png)\n",
        "a.png": png("a"),
        "cut.png": png("cut"),
        "z.png": png("z"),
      })
      const summary = await run(remote, workspaceId, tip)
      expect(summary).toMatchObject({ mode: "full", failedCount: 1 })
      const documentOf = async (path: string) =>
        (await store.readDocument(scope, key(workspaceId, path)))?.document
      expect(await documentOf("cut.png")).toMatchObject({
        status: "failed",
        error: "The embedding model refused the image (HTTP 400).",
      })
      for (const path of ["a.png", "z.png"])
        expect(
          (await store.readDocument(scope, key(workspaceId, path)))?.chunks[0]
            ?.embedding,
        ).toHaveLength(multimodalEmbeddingConfig.dimensions)
    } finally {
      await remote.remove()
    }
  })
})

describe("vector reuse (CTX-1428)", () => {
  /** Make the stored projection version old, so that the next run is full. */
  const staleVersion = (workspaceId: string) =>
    withOrgDbContext(orgId, (db) =>
      db
        .update(knowledgeState)
        .set({ projectionVersion: "old" })
        .where(
          and(
            eq(knowledgeState.organizationId, orgId),
            eq(knowledgeState.workspaceId, workspaceId),
          ),
        ),
    )
  const embeddingOf = () =>
    spans.spanNamed("knowledge.projection.apply")?.attributes
  /** The text of each request since the last reset. */
  const sentTexts = () =>
    embeddings.inputs.flat().map((input) => JSON.stringify(input.content))
  const files = {
    "a.md": "# Alpha\n\nThe first part.\n\n## Two\n\nThe second part.\n",
    "b.md": "# Beta\n\nSee [a](a.md).\n",
    "c.md": "# Gamma\n\n![d](img/d.png)\n",
    "img/d.png": png("one"),
    // The same content in two files: one request.
    "same-1.md": "# Same\n\nThe same text.\n",
    "same-2.md": "# Same\n\nThe same text.\n",
  }
  const paths = [...Object.keys(files), "n.md"]

  it("a full rebuild after a projection version change embeds only new text, and gives the tables of a rebuild with no stored vectors", async () => {
    const remote = await Remote.create()
    try {
      const workspaceId = await newWorkspace()
      await run(remote, workspaceId, await remote.commit(files))
      const first = sentTexts()
      expect(new Set(first).size).toBe(first.length)
      const inputs =
        Number(embeddingOf()?.["ctxpipe.knowledge.embedding_embedded"]) || 0
      expect(embeddingOf()).toMatchObject({
        "ctxpipe.knowledge.embedding_reused": 0,
        "ctxpipe.knowledge.embedding_requests": inputs - 1,
      })
      expect(first).toHaveLength(inputs - 1)

      // A parser change (a new projection version), a changed file and a
      // new file.
      const tip = await remote.commit({
        "b.md": "# Beta\n\nSee [a](a.md) again.\n",
        "n.md": "# New\n\nA new file.\n",
      })
      await staleVersion(workspaceId)
      embeddings.requests = 0
      embeddings.inputs = []
      spans.reset()
      expect(await run(remote, workspaceId, tip)).toMatchObject({
        mode: "full",
        fullReason: "projection_version",
      })
      // Only the text of b.md and n.md goes to the model.
      expect(embeddings.requests).toBe(2)
      expect(sentTexts()).toHaveLength(2)
      expect(sentTexts()).toEqual(
        expect.arrayContaining([
          expect.stringContaining("again."),
          expect.stringContaining("A new file."),
        ]),
      )
      expect(embeddingOf()).toMatchObject({
        "ctxpipe.knowledge.embedding_reused": inputs - 1,
        "ctxpipe.knowledge.embedding_embedded": 2,
        "ctxpipe.knowledge.embedding_requests": 2,
      })

      // A Workspace with no stored vectors embeds each input.
      embeddings.inputs = []
      const fresh = await newWorkspace()
      await run(remote, fresh, tip)
      expect(embeddingOf()).toMatchObject({
        "ctxpipe.knowledge.embedding_reused": 0,
      })
      const left = await content(workspaceId, paths)
      const right = await content(fresh, paths)
      for (const table of tables)
        expect(left[table], table).toEqual(right[table])
      expect(left.chunks.length).toBe(inputs + 1)
      expect(left.chunks.every((row) => row.embedding_key !== "")).toBe(true)
      // The tables hold the BFloat16 values, not the vectors of the answers:
      // the equal tables compare stored values.
      const answered = new Set(
        embeddings.inputs
          .flat()
          .map((input) => JSON.stringify(vectorOf(input.content))),
      )
      expect(answered.size).toBe(inputs)
      expect(
        right.chunks.filter((row) =>
          answered.has(JSON.stringify(row.embedding)),
        ),
      ).toEqual([])
    } finally {
      await remote.remove()
    }
  })

  it("a retry after a run that failed after its first write of 1000 files embeds only the files of the later writes", async () => {
    const remote = await Remote.create()
    try {
      // 1005 files: the first write has 1000 files, the second 5.
      const count = 1005
      const name = (index: number) => `f${String(index).padStart(4, "0")}.md`
      const tip = await remote.commit(
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            name(index),
            `# File ${index}\n\nThe text of file ${index}.\n`,
          ]),
        ),
      )
      const workspaceId = await newWorkspace()
      // The first request of the second write fails the run, after the
      // first write is in ClickHouse. The 5 requests of the second write
      // start together.
      embeddings.failAt = 1001
      await expect(run(remote, workspaceId, tip)).rejects.toThrow("HTTP 401")
      expect(embeddings.requests).toBe(1005)
      expect(await getKnowledgeState({ orgId, workspaceId })).toMatchObject({
        lastSha: null,
        attemptShas: [tip],
      })

      embeddings.failAt = 0
      embeddings.requests = 0
      embeddings.inputs = []
      spans.reset()
      expect(await run(remote, workspaceId, tip)).toMatchObject({
        mode: "full",
      })
      expect(embeddings.requests).toBe(5)
      expect(sentTexts().sort()).toEqual(
        Array.from({ length: 5 }, (_, index) =>
          expect.stringContaining(`The text of file ${1000 + index}.`),
        ),
      )
      expect(embeddingOf()).toMatchObject({
        "ctxpipe.knowledge.outcome": "completed",
        "ctxpipe.knowledge.embedding_reused": 1000,
        "ctxpipe.knowledge.embedding_embedded": 5,
        "ctxpipe.knowledge.embedding_requests": 5,
      })
      const statuses = Object.values(await statusOf(workspaceId))
      expect(statuses).toHaveLength(count)
      expect(statuses.every((status) => status === "active")).toBe(true)
    } finally {
      await remote.remove()
    }
  }, 120_000)

  it("a change of the embedding model embeds each input again", async () => {
    const remote = await Remote.create()
    const model = multimodalEmbeddingConfig.model
    try {
      const workspaceId = await newWorkspace()
      const tip = await remote.commit(files)
      await run(remote, workspaceId, tip)
      const requests = embeddings.requests
      multimodalEmbeddingConfig.model = "test/other-embedding"
      embeddings.requests = 0
      spans.reset()
      expect(await run(remote, workspaceId, tip)).toMatchObject({
        mode: "full",
        fullReason: "projection_version",
      })
      expect(embeddings.requests).toBe(requests)
      expect(embeddingOf()).toMatchObject({
        "ctxpipe.knowledge.embedding_reused": 0,
        "ctxpipe.knowledge.embedding_requests": requests,
      })
    } finally {
      multimodalEmbeddingConfig.model = model
      await remote.remove()
    }
  })
})
