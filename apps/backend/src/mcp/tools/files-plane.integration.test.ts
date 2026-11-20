import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import { withOrgDbContext } from "../../db/client.js"
import { knowledgeState } from "../../db/schema/knowledge_state.js"
import { orgFeatures } from "../../db/schema/org_features.js"
import {
  workspaceKnowledgeUnits,
  workspaces,
} from "../../db/schema/workspaces.js"
import { servingIdForKnowledgePath } from "../../domain/workspaces/hydrate.js"
import type { WorkspaceRevision } from "../../domain/workspaces/revision.js"
import { createKnowledgeStore } from "../../knowledge-store/knowledge-store.js"
import { migrateKnowledgeStore } from "../../knowledge-store/migrate.js"
import {
  beginKnowledgeRun,
  completeKnowledgeRun,
} from "../../models/knowledge-state.js"
import { startClickHouse, userUrl } from "../../test/clickhouse.js"
import {
  callTool,
  connectToolClient,
  dropOrgGraph,
  seedRelatedWorkspace,
} from "../../test/related-fixture.js"
import { TOOL_ERROR_META_KEY } from "../framework/tool-result.js"
import { listFilesTool } from "./list-files.js"
import { readFileTool } from "./read-file.js"

/*
 * `read_file` and `list_files` behind the `knowledge_plane` flag (CTX-1409):
 * on the plane they read the Workspace Git at the SHA that the plane serves.
 * Real Postgres, FalkorDB, ClickHouse and a real Git repository.
 */

const exec = promisify(execFile)
const legacySha = "a".repeat(40)
const CHECKOUT = "knowledge/services/checkout.md"
const PAYMENTS = "knowledge/teams/payments.md"
/** Six lines of front matter: the body starts at file line 7. */
const checkoutFile = (version: string) =>
  [
    "---",
    "kind: Service",
    "title: Checkout service",
    "claims:",
    `  - { to: ../teams/payments.md, predicate: OWNED_BY, confidence: 0.9 }`,
    "---",
    "# Checkout service",
    "",
    `Version ${version} of the checkout service.`,
    "",
  ].join("\n")
/** The payments unit names a source file: hydrate gives it a FROM_SOURCE claim. */
const paymentsFile =
  "---\nsources:\n  - sources/notes.md\n---\n# Payments team\n\nThe payments team owns checkout.\n"
const observedAt = new Date("2026-11-01T00:00:00.000Z")

let seed: SeededOrg
let clickHouse: Awaited<ReturnType<typeof startClickHouse>>
let repository: string
/** The commit that the plane serves, and a later commit. */
let servedSha: string
let laterSha: string
let workspaceId: string
let readClient: Client
let listClient: Client
let clock = Date.now()

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repository, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  })
  return stdout.trim()
}

/** Write the files, and commit them. Returns the commit SHA. */
async function commit(files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repository, path)), { recursive: true })
    await writeFile(join(repository, path), content)
  }
  await git("add", "-A")
  await git("commit", "-q", "-m", "fixture")
  return git("rev-parse", "HEAD")
}

/** Set the org flag, and move the clock past the 30-second flag cache. */
async function setFlag(value: "off" | "shadow" | "on") {
  await withOrgDbContext(seed.orgId, (db) =>
    db
      .insert(orgFeatures)
      .values({ organizationId: seed.orgId, feature: "knowledge_plane", value })
      .onConflictDoUpdate({
        target: [orgFeatures.organizationId, orgFeatures.feature],
        set: { value },
      }),
  )
  clock += 31_000
  vi.setSystemTime(clock)
}

async function setReady(ready: boolean) {
  await withOrgDbContext(seed.orgId, (db) =>
    db
      .delete(knowledgeState)
      .where(
        and(
          eq(knowledgeState.organizationId, seed.orgId),
          eq(knowledgeState.workspaceId, workspaceId),
        ),
      ),
  )
  if (!ready) return
  await beginKnowledgeRun({ orgId: seed.orgId, workspaceId, tip: servedSha, hydratedAt: new Date() })
  await completeKnowledgeRun({
    orgId: seed.orgId,
    workspaceId,
    tip: servedSha,
    projectionVersion: "test",
    failedCount: 0,
  })
}

const structured = (result: CallToolResult) =>
  result.structuredContent as Record<string, unknown> & {
    served: { branch: string; sha: string }
  }
const errorCode = (result: CallToolResult) =>
  (result._meta?.[TOOL_ERROR_META_KEY] as { code?: string } | undefined)?.code
const readFile = (args: Record<string, unknown>) =>
  callTool(readClient, "read_file", {
    org: seed.orgSlug,
    workspace: "plane-files",
    ...args,
  })
const listFiles = (args: Record<string, unknown> = {}) =>
  callTool(listClient, "list_files", {
    org: seed.orgSlug,
    workspace: "plane-files",
    ...args,
  })

/** The keys and the types of a value, with the union of the keys of array items. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    const merged: Record<string, unknown> = {}
    for (const item of value.map(shapeOf))
      if (item && typeof item === "object") Object.assign(merged, item)
    return value.length === 0
      ? []
      : [typeof value[0] === "object" ? merged : shapeOf(value[0])]
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, shapeOf(item)]),
    )
  return typeof value
}

describe("read_file and list_files on the knowledge plane", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    vi.useFakeTimers({ now: clock, toFake: ["Date"] })
    clickHouse = await startClickHouse()
    const url = await clickHouse.freshDatabase()
    await migrateKnowledgeStore(url, {
      reader: "reader-test",
      writer: "writer-test",
    })
    vi.stubEnv("CLICKHOUSE_URL", userUrl(url, "ctxpipe_reader", "reader-test"))

    repository = await mkdtemp(join(tmpdir(), "ctxpipe-plane-files-"))
    await git("init", "-q", "-b", "main")
    servedSha = await commit({
      [CHECKOUT]: checkoutFile("A"),
      [PAYMENTS]: paymentsFile,
      "sources/notes.md": "# Meeting notes\n",
      "AGENTS.md": "# Agent instructions\n",
    })
    // After the served SHA: a changed unit and a new unit.
    laterSha = await commit({
      [CHECKOUT]: checkoutFile("B"),
      "knowledge/new.md": "# New\n",
    })

    seed = await seedOrg()
    const seeded = await seedRelatedWorkspace({
      seed,
      slug: "plane-files",
      sha: legacySha,
      units: [
        {
          path: CHECKOUT,
          kind: "Service",
          title: "Checkout service",
          body: "# Checkout service\n\nThe legacy body.\n",
        },
        { path: PAYMENTS, kind: "Team", title: "Payments team" },
      ],
      chunks: true,
    })
    workspaceId = seeded.workspaceId
    // The Workspace repository is the Git repository of the test.
    const revision: WorkspaceRevision = {
      ...seeded.revision,
      remote: { url: repository, connectionId: null },
    }
    await withOrgDbContext(seed.orgId, async (db) => {
      await db
        .update(workspaces)
        .set({ activeRevision: revision, workspaceRepositoryUrl: repository })
        .where(eq(workspaces.id, workspaceId))
      await db
        .update(workspaceKnowledgeUnits)
        .set({
          claims: [
            {
              to: "../teams/payments.md",
              predicate: "OWNED_BY",
              confidence: 0.9,
              validFrom: null,
              validTo: null,
              source: null,
            },
          ],
        })
        .where(
          and(
            eq(workspaceKnowledgeUnits.workspaceId, workspaceId),
            eq(workspaceKnowledgeUnits.path, CHECKOUT),
          ),
        )
    })
    const writer = createKnowledgeStore(url)
    try {
      // The payments unit has no document row on the plane.
      await writer.applyDocuments(
        { orgId: seed.orgId, workspaceId },
        {
          documents: [CHECKOUT].map((path) => ({
            document: {
              docKey: servingIdForKnowledgePath(workspaceId, path),
              kind: "",
              title: path,
              path,
              sourceType: "docs",
              source: "",
              summary: "",
              mime: "",
              validFrom: null,
              validTo: null,
              observedAt,
            },
            chunks: [],
            relations: [],
          })),
        },
      )
    } finally {
      await writer.close()
    }
    readClient = await connectToolClient(seed, readFileTool)
    listClient = await connectToolClient(seed, listFilesTool)
  }, 240_000)

  afterAll(async () => {
    await readClient?.close()
    await listClient?.close()
    if (seed) {
      await withOrgDbContext(seed.orgId, (db) =>
        db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId)),
      )
      await dropOrgGraph(seed.orgId)
      await cleanupSeededOrg(seed)
    }
    await clickHouse?.stop()
    if (repository) await rm(repository, { recursive: true, force: true })
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it.each([
    ["off", true],
    ["shadow", true],
    ["on", false],
  ] as const)(
    "flag %s, ready %s: the old stack answers",
    async (flag, ready) => {
      await setFlag(flag)
      await setReady(ready)
      const read = await readFile({ ref: CHECKOUT })
      expect(read.isError).toBeFalsy()
      expect(structured(read)).toMatchObject({
        served: { branch: "main", sha: legacySha },
        content: "# Checkout service\n\nThe legacy body.",
      })
      const list = await listFiles({ path: "knowledge", depth: 1 })
      expect(structured(list)).toMatchObject({
        served: { sha: legacySha },
        entries: [
          { path: "knowledge/services", type: "dir", units: 1 },
          { path: "knowledge/teams", type: "dir", units: 1 },
        ],
      })
    },
  )

  describe("flag on, Workspace ready", () => {
    beforeAll(async () => {
      await setFlag("on")
      await setReady(true)
    })

    it("read_file reads the unit at the served SHA, not a later commit", async () => {
      const result = await readFile({ ref: CHECKOUT })
      expect(result.isError).toBeFalsy()
      expect(structured(result)).toEqual({
        ref: CHECKOUT,
        served: { branch: "main", sha: servedSha },
        frontMatter: {
          kind: "Service",
          title: "Checkout service",
          source: "authored",
          updatedAt: observedAt.toISOString(),
          claims: [
            {
              to: "../teams/payments.md",
              predicate: "OWNED_BY",
              confidence: 0.9,
            },
          ],
        },
        content: "# Checkout service\n\nVersion A of the checkout service.",
        startLine: 7,
        endLine: 9,
        totalLines: 9,
        nextStartLine: null,
        truncated: false,
      })
      expect(laterSha).not.toBe(servedSha)
    })

    it("read_file keeps file lines and the cursor of the old stack", async () => {
      const first = structured(
        await readFile({ ref: CHECKOUT, startLine: 7, endLine: 7 }),
      )
      expect(first).toMatchObject({
        content: "# Checkout service",
        startLine: 7,
        endLine: 7,
        nextStartLine: null,
      })
      const later = structured(await readFile({ ref: CHECKOUT, startLine: 9 }))
      expect(later.content).toBe("Version A of the checkout service.")
      expect(later.frontMatter).toBeUndefined()
      const frontMatterLines = await readFile({ ref: CHECKOUT, endLine: 3 })
      expect(errorCode(frontMatterLines)).toBe("invalid_argument")
    })

    it("read_file gives unknown_ref for a path that the served SHA does not have as a unit", async () => {
      for (const ref of [
        "knowledge/missing.md",
        // Added after the served SHA.
        "knowledge/new.md",
        // In Git, but not a knowledge unit.
        "AGENTS.md",
      ]) {
        const result = await readFile({ ref })
        expect(errorCode(result), ref).toBe("unknown_ref")
      }
    })

    it("read_file reads a Git unit that has no plane document; updatedAt is the read time", async () => {
      const result = await readFile({ ref: PAYMENTS })
      expect(result.isError).toBeFalsy()
      expect(structured(result)).toMatchObject({
        served: { sha: servedSha },
        frontMatter: {
          updatedAt: new Date(clock).toISOString(),
          // A claim that comes from another file (`sources/`) at the served SHA.
          claims: [
            {
              to: "workspace:sources/notes.md",
              predicate: "FROM_SOURCE",
              confidence: 1,
              source: "git",
            },
          ],
        },
        content: "# Payments team\n\nThe payments team owns checkout.",
      })
    })

    it("list_files lists the units of the served SHA, with their body sizes", async () => {
      const root = structured(await listFiles())
      expect(root).toEqual({
        repository: null,
        path: "",
        served: { branch: "main", sha: servedSha },
        entries: [
          { path: "knowledge", type: "dir", units: 2 },
          { path: "knowledge/services", type: "dir", units: 1 },
          { path: "knowledge/teams", type: "dir", units: 1 },
          { path: "sources", type: "dir", units: 1 },
          {
            path: "sources/notes.md",
            type: "file",
            ref: "sources/notes.md",
            size: 16,
          },
        ],
      })
      const services = structured(
        await listFiles({ path: "knowledge/services" }),
      )
      expect(services.entries).toEqual([
        {
          path: CHECKOUT,
          type: "file",
          ref: CHECKOUT,
          // The body without front matter, as on the old stack.
          size: Buffer.byteLength(
            "# Checkout service\n\nVersion A of the checkout service.\n",
          ),
        },
      ])
      const missing = await listFiles({ path: "knowledge/nope" })
      expect(errorCode(missing)).toBe("unknown_ref")
    })

    it("list_files pages with a cursor bound to the served SHA", async () => {
      const first = structured(await listFiles({ limit: 3 }))
      expect(first.entries).toHaveLength(3)
      expect(first.cursor).toEqual(expect.any(String))
      const next = structured(
        await listFiles({ limit: 3, cursor: first.cursor }),
      )
      expect(next.entries).toMatchObject([
        { path: "sources" },
        { path: "sources/notes.md" },
      ])
      expect(next.cursor).toBeUndefined()
    })

    it("both tools give the output shape of the old stack", async () => {
      const plane = {
        read: structured(await readFile({ ref: CHECKOUT })),
        list: structured(await listFiles({ path: "knowledge", depth: 3 })),
      }
      await setFlag("off")
      try {
        const legacy = {
          read: structured(await readFile({ ref: CHECKOUT })),
          list: structured(await listFiles({ path: "knowledge", depth: 3 })),
        }
        expect(shapeOf(plane)).toEqual(shapeOf(legacy))
      } finally {
        await setFlag("on")
      }
    })
  })
})
