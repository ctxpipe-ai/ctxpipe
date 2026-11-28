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
import { knowledgeBranchHeads } from "../../db/schema/knowledge_state.js"
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
import { writePlaneDocuments } from "../../test/knowledge-plane.js"
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
/** The times of the tree rows: the commits that added and changed a file. */
const createdAt = new Date("2026-09-01T00:00:00.000Z")
const updatedAt = new Date("2026-10-01T00:00:00.000Z")

let seed: SeededOrg
let clickHouse: Awaited<ReturnType<typeof startClickHouse>>
let repository: string
/** The admin URL of the knowledge database, for test writes. */
let knowledgeUrl: string
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
  // The reader reads only the heads (ADR-071 decision 4).
  await withOrgDbContext(seed.orgId, (db) =>
    db
      .delete(knowledgeBranchHeads)
      .where(
        and(
          eq(knowledgeBranchHeads.organizationId, seed.orgId),
          eq(knowledgeBranchHeads.workspaceId, workspaceId),
        ),
      ),
  )
  if (!ready) return
  await beginKnowledgeRun({
    orgId: seed.orgId,
    workspaceId,
    branch: "main",
    isDefault: true,
  })
  await completeKnowledgeRun({
    orgId: seed.orgId,
    workspaceId,
    tip: servedSha,
    branch: "main",
    treeVersion: 1,
    baseBranch: null,
    projectionVersion: "test",
    failedCount: 0,
    caseDuplicateRows: 0,
    caseDuplicates: 0,
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
    knowledgeUrl = url
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
      await writePlaneDocuments(
        writer,
        { orgId: seed.orgId, workspaceId },
        [CHECKOUT].map((path) => ({
          document: {
            docKey: servingIdForKnowledgePath(workspaceId, path),
            kind: "",
            title: path,
            path,
            sourceType: "docs",
            source: "",
            summary: "",
            mime: "",
            createdAt,
            updatedAt,
            expiresAt: null,
            observedAt,
          },
          chunks: [],
          relations: [],
        })),
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
          createdAt: createdAt.toISOString(),
          updatedAt: updatedAt.toISOString(),
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

    it("read_file reads a Git unit that has no plane document; its times are unknown", async () => {
      const result = await readFile({ ref: PAYMENTS })
      expect(result.isError).toBeFalsy()
      expect(structured(result)).toMatchObject({
        served: { sha: servedSha },
        frontMatter: {
          createdAt: null,
          updatedAt: null,
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

    it("on a branch, each file comes from the tip of the branch of its row of the view", async () => {
      // The branch forks at the served SHA. It changes the payments unit and
      // adds a unit. Its Git also changes the checkout unit, but the view
      // takes the checkout unit from the default branch (its overlay has no
      // row of it), so a read gives the file of the default branch.
      await git("checkout", "-q", "-b", "feature", servedSha)
      const branchSha = await commit({
        [PAYMENTS]: paymentsFile.replace("owns checkout", "owns checkout on B"),
        "knowledge/branch.md": "# Branch only\n\nOnly on the branch.\n",
        [CHECKOUT]: checkoutFile("F"),
      })
      await git("checkout", "-q", "main")
      const writer = createKnowledgeStore(knowledgeUrl)
      try {
        await writePlaneDocuments(
          writer,
          { orgId: seed.orgId, workspaceId },
          [PAYMENTS, "knowledge/branch.md"].map((path) => ({
            document: {
              docKey: servingIdForKnowledgePath(workspaceId, path),
              kind: "",
              title: path,
              path,
              sourceType: "docs",
              source: "",
              summary: "",
              mime: "",
              createdAt,
              updatedAt,
              expiresAt: null,
              observedAt,
            },
            chunks: [],
            relations: [],
          })),
          { branch: "feature" },
        )
      } finally {
        await writer.close()
      }
      const head = { orgId: seed.orgId, workspaceId, branch: "feature" }
      await beginKnowledgeRun({ ...head, isDefault: false })
      await completeKnowledgeRun({
        ...head,
        tip: branchSha,
        treeVersion: 1,
        baseBranch: "main",
        projectionVersion: "test",
        failedCount: 0,
        caseDuplicateRows: 0,
        caseDuplicates: 0,
      })

      const payments = structured(
        await readFile({ ref: PAYMENTS, branch: "feature" }),
      )
      expect(payments.served).toEqual({ branch: "feature", sha: branchSha })
      expect(payments.content).toContain("owns checkout on B")
      const checkout = structured(
        await readFile({ ref: CHECKOUT, branch: "feature" }),
      )
      expect(checkout.content).toContain("Version A of the checkout service.")
      // The default branch does not see the overlay.
      expect((await readFile({ ref: "knowledge/branch.md" })).isError).toBe(
        true,
      )

      const list = structured(
        await listFiles({ path: "knowledge", depth: 3, branch: "feature" }),
      )
      expect(
        (list.entries as { path: string; type: string }[])
          .filter((entry) => entry.type === "file")
          .map((entry) => entry.path),
      ).toEqual(["knowledge/branch.md", CHECKOUT, PAYMENTS])
    })

    it("a path that differs from another only in case gives one answer: read_file reads the copy that the view shows, and list_files lists it one time (CTX-1697)", async () => {
      // An outside commit adds a copy whose path differs only in case. The
      // index gets it from its blob: the disk of the test can ignore case.
      const copy = "knowledge/services/Checkout.md"
      await git("checkout", "-q", "-b", "cased", servedSha)
      const body = join(tmpdir(), `ctxpipe-case-${Date.now()}.md`)
      await writeFile(body, "# Checkout copy\n\nThe mixed-case copy.\n")
      const blob = await git("hash-object", "-w", body)
      await rm(body)
      await git(
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${blob},${copy}`,
      )
      await git("commit", "-q", "-m", "An outside copy")
      const casedSha = await git("rev-parse", "HEAD")
      await git("checkout", "-q", "-f", "main")
      const writer = createKnowledgeStore(knowledgeUrl)
      try {
        await writePlaneDocuments(
          writer,
          { orgId: seed.orgId, workspaceId },
          [
            {
              document: {
                docKey: servingIdForKnowledgePath(workspaceId, copy),
                kind: "",
                title: copy,
                path: copy,
                sourceType: "docs",
                source: "",
                summary: "",
                mime: "",
                observedAt,
              },
              chunks: [],
              relations: [],
            },
          ],
          { branch: "cased" },
        )
      } finally {
        await writer.close()
      }
      const head = { orgId: seed.orgId, workspaceId, branch: "cased" }
      await beginKnowledgeRun({ ...head, isDefault: false })
      await completeKnowledgeRun({
        ...head,
        tip: casedSha,
        treeVersion: 1,
        baseBranch: "main",
        projectionVersion: "test",
        failedCount: 0,
        caseDuplicateRows: 1,
        caseDuplicates: 1,
      })

      // The copy has no time, so the canonical lowercase path shows.
      for (const ref of [CHECKOUT, copy]) {
        const read = structured(await readFile({ ref, branch: "cased" }))
        expect(read.content).toContain("Version A of the checkout service.")
      }
      const list = structured(
        await listFiles({
          path: "knowledge/services",
          depth: 1,
          branch: "cased",
        }),
      )
      expect(
        (list.entries as { path: string; type: string }[]).map(
          (entry) => entry.path,
        ),
      ).toEqual([CHECKOUT])
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
        // Only the plane knows the createdAt of a unit (CTX-1710): the old
        // stack gives null.
        const withoutCreatedAt = (files: typeof plane) => {
          const { createdAt: _createdAt, ...frontMatter } = files.read
            .frontMatter as Record<string, unknown>
          return { ...files, read: { ...files.read, frontMatter } }
        }
        expect(shapeOf(withoutCreatedAt(plane))).toEqual(
          shapeOf(withoutCreatedAt(legacy)),
        )
      } finally {
        await setFlag("on")
      }
    })
  })
})
