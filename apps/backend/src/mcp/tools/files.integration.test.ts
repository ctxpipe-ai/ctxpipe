import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { HttpResponse, http } from "msw"
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
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import { useMswServer } from "../../../test/msw.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import {
  workspaceKnowledgeChunks,
  workspaceKnowledgeUnits,
  workspaces,
} from "../../db/schema/workspaces.js"
import { knowledgeChunkRows } from "../../domain/workspaces/knowledge-chunks.js"
import { generateObjectId } from "../../lib/id.js"
import { registerMcpRoutes } from "../../routes/mcp.js"
import { withTestRequestLogger } from "../../test/hono-test-logger.js"
import { insertLinkedRepositoryRows } from "../../test/workspace-links-fixture.js"
import { HARD_CAP_CHARS } from "../framework/budget.js"
import { registerMcpReadTools } from "../framework/tool-registry.js"
import { TOOL_ERROR_META_KEY } from "../framework/tool-result.js"
import { listFilesTool } from "./list-files.js"
import { readFileTool } from "./read-file.js"

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()
const CODESEARCH = "http://codesearch.test"

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const sha1 = "a".repeat(40)
const sha2 = "b".repeat(40)
const owner = `ex${suffix}`
const handle = (short: string) => `${owner}/${short}`

let seed: SeededOrg
const foreignOrg = {
  id: generateObjectId("org"),
  slug: `files-foreign-${suffix}`,
}
const paymentsId = generateObjectId("ws")
const platformId = generateObjectId("ws")
const pagingId = generateObjectId("ws")
const foreignWorkspaceId = generateObjectId("ws")

const BIG_LINES = Array.from(
  { length: 600 },
  (_, index) => `line ${String(index + 1).padStart(3, "0")} ${"x".repeat(60)}`,
)
/** Lines full of characters that JSON escapes, so each line costs double. */
const QUOTE_LINES = Array.from(
  { length: 300 },
  (_, index) => `${index} ${'"\\'.repeat(40)}`,
)
const UNITS: Record<string, string> = {
  "knowledge/quotes.md": `${QUOTE_LINES.join("\n")}\n`,
  "knowledge/services/payments-api.md":
    "# Payments API\n\nOwns card charges.\nCalls the ledger.\n",
  "knowledge/runbooks/deploy.md": "# Deploy\n\nRun the pipeline.\n",
  "knowledge/big.md": `${BIG_LINES.join("\n")}\n`,
  "knowledge/long-line.md": `${"y".repeat(60_000)}\n`,
  "slack/threads/c1:1728.md": "A thread about limits.\n",
}
const MANY = Array.from(
  { length: 25 },
  (_, index) => `knowledge/many/unit-${String(index).padStart(2, "0")}.md`,
)

/** 100 units whose paths are 55 characters long. */
const WIDE = Array.from(
  { length: 100 },
  (_, index) =>
    `knowledge/wide/${String(index).padStart(3, "0")}-${"n".repeat(33)}.md`,
)
/** A unit with three lines of front matter; its body starts at file line 4. */
const FRONT_MATTER_UNIT = {
  path: "knowledge/front-matter.md",
  body: "# Rate limits\n\nThe gateway allows 100 calls.\n",
  bodyStartLine: 4,
}

/** Repository name → repository id (after the seed). */
const seeded = new Map<string, string>()
/** Files of each linked repository checkout. */
const REPOSITORY_FILES: Record<string, Record<string, string>> = {
  "payments-api": {
    "src/limits.ts": "export const LIMIT = 100\nexport const MAX = 5\n",
    "src/index.ts": "export * from './limits'\n",
    "README.md": "# payments-api\n",
  },
  ledger: { "README.md": "# ledger\n" },
  "huge-api": { "README.md": "# huge\n" },
  "other-api": { "README.md": "# other\n" },
}

type Captured = {
  path: string
  body?: Record<string, unknown>
  /** Claims of the codesearch token. */
  claims?: Record<string, unknown>
}
let captured: Captured[] = []

function repositoryOf(id: string): string {
  for (const [short, row] of seeded) if (row === id) return short
  throw new Error(`unknown repository id ${id}`)
}

/**
 * Codesearch for the published checkouts. `files-query` omits a path that
 * is not in the checkout, as codesearch does for a missing file and for a
 * symlink that points out of the checkout.
 */
function codesearch() {
  return [
    http.post(
      `${CODESEARCH}/:repoId/files-query`,
      async ({ request, params }) => {
        const body = (await request.json()) as { paths: string[] }
        const token = request.headers.get("authorization")?.split(".")[1]
        captured.push({
          path: new URL(request.url).pathname,
          body,
          claims: token
            ? JSON.parse(Buffer.from(token, "base64url").toString("utf8"))
            : undefined,
        })
        const files =
          REPOSITORY_FILES[repositoryOf(String(params.repoId))] ?? {}
        const result: Record<string, string> = {}
        for (const path of body.paths) {
          const text = files[path]
          if (text !== undefined)
            result[path] = Buffer.from(text).toString("base64")
        }
        if (repositoryOf(String(params.repoId)) === "payments-api") {
          // A binary file of the checkout.
          if (body.paths.includes("logo.png"))
            result["logo.png"] = Buffer.from([0x89, 0x50, 0, 0, 1]).toString(
              "base64",
            )
        }
        return HttpResponse.json(result)
      },
    ),
    http.post(`${CODESEARCH}/:repoId/glob`, async ({ request, params }) => {
      const body = (await request.json()) as { path: string; pattern: string }
      captured.push({ path: new URL(request.url).pathname, body })
      const files = Object.keys(
        REPOSITORY_FILES[repositoryOf(String(params.repoId))] ?? {},
      )
      const prefix = body.path ? `${body.path}/` : ""
      // "*" lists one level; "{*,*/*}" lists two, and so on.
      const depth = body.pattern === "*" ? 1 : body.pattern.split(",").length
      const children = new Map<string, "file" | "dir">()
      for (const file of files) {
        if (!file.startsWith(prefix)) continue
        const parts = file.slice(prefix.length).split("/")
        for (let level = 1; level <= Math.min(depth, parts.length); level++)
          children.set(
            parts.slice(0, level).join("/"),
            level < parts.length ? "dir" : "file",
          )
      }
      if (children.size === 0) {
        return HttpResponse.json({ error: "Path not found" }, { status: 404 })
      }
      const entries = [...children].map(([relative, type]) => ({
        name: relative.split("/").at(-1),
        path: `${prefix}${relative}`,
        type,
      }))
      return HttpResponse.json({
        entries,
        // The checkout of this repository has more entries than one glob gives.
        truncated: repositoryOf(String(params.repoId)) === "huge-api",
        matched: entries.length,
      })
    }),
  ]
}

function createApp() {
  const app = new Hono<AppEnv>()
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use(evlog())
  app.use("*", async (c, next) => {
    c.set("env", parseEnv(process.env as Record<string, string | undefined>))
    c.set("user", null)
    c.set("session", null)
    c.set("oauthReferenceId", null)
    c.set("oauthClientId", null)
    c.set("orgApiKey", null)
    c.set("personalApiKeyId", null)
    c.set("orgSlug", null)
    c.set("orgId", null)
    await next()
  })
  registerMcpRoutes(app, {
    registerTools: (mcp: McpServer) =>
      registerMcpReadTools(mcp, [readFileTool, listFilesTool]),
  })
  return app
}

async function connect(): Promise<Client> {
  const app = createApp()
  const client = new Client({ name: "files-test", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (url, init) => app.request(String(url), init),
      requestInit: { headers: { "x-api-key": seed.orgApiKey } },
    }),
  )
  // The SDK Client checks each result against the output schema after
  // tools/list.
  await client.listTools()
  return client
}

type ToolResult = {
  isError?: boolean
  structuredContent?: Record<string, unknown>
  content?: Array<{ type: string; text?: string }>
  _meta?: Record<string, unknown>
}

let client: Client

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({
    name,
    arguments: { org: seed.orgSlug, workspace: "payments", ...args },
  })) as ToolResult
}

function errorCode(result: ToolResult): unknown {
  expect(result.isError).toBe(true)
  return (result._meta?.[TOOL_ERROR_META_KEY] as { code?: string })?.code
}

describe("read_file and list_files (Postgres + msw codesearch + MCP SDK Client)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    seed = await seedOrg()
    await getSystemDb().insert(organizations).values({
      id: foreignOrg.id,
      name: foreignOrg.slug,
      slug: foreignOrg.slug,
      createdAt: new Date(),
    })
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(workspaces).values(
        [
          [paymentsId, "payments", sha1],
          [platformId, "platform", null],
          [pagingId, "paging", sha1],
        ].map(([id, slug, sha]) => ({
          id: id as string,
          orgId: seed.orgId,
          slug: slug as string,
          displayName: slug as string,
          workspaceRepositoryUrl: `/tmp/files-${suffix}-${slug}`,
          desiredDefaultBranch: "main",
          activeProjectionSha: sha,
        })),
      )
      await db.insert(workspaceKnowledgeUnits).values([
        ...Object.entries(UNITS).map(([path, body]) => ({
          servingId: generateObjectId("wku"),
          orgId: seed.orgId,
          workspaceId: paymentsId,
          path,
          body,
          projectionSha: sha1,
        })),
        ...[...MANY, ...WIDE].map((path) => ({
          servingId: generateObjectId("wku"),
          orgId: seed.orgId,
          workspaceId: pagingId,
          path,
          body: "x\n",
          projectionSha: sha1,
        })),
      ])
      // The row of this unit is from a later projection than the Workspace
      // serves, and its chunks hold file lines that count the front matter.
      const frontMatterId = generateObjectId("wku")
      await db.insert(workspaceKnowledgeUnits).values({
        servingId: frontMatterId,
        orgId: seed.orgId,
        workspaceId: paymentsId,
        path: FRONT_MATTER_UNIT.path,
        body: FRONT_MATTER_UNIT.body,
        projectionSha: sha2,
        kind: "Standard",
        title: "Rate limits",
        source: "authored",
        updatedAt: new Date("2026-09-01T00:00:00Z"),
        claims: [
          {
            to: "knowledge/services/gateway.md",
            predicate: "APPLIES_TO",
            confidence: 0.9,
            validFrom: null,
            validTo: null,
            source: null,
          },
        ],
      })
      await db.insert(workspaceKnowledgeChunks).values(
        knowledgeChunkRows(
          [
            {
              servingId: frontMatterId,
              body: FRONT_MATTER_UNIT.body,
              title: "Rate limits",
              bodyStartLine: FRONT_MATTER_UNIT.bodyStartLine,
            },
          ],
          "test-model",
        ).map((row) => ({
          ...row,
          orgId: seed.orgId,
          workspaceId: paymentsId,
        })),
      )
      await insertLinkedRepositoryRows(db, [
        ...["payments-api", "ledger", "unindexed", "huge-api"].map((short) => ({
          id: generateObjectId("wlr"),
          orgId: seed.orgId,
          workspaceId: paymentsId,
          gitUrl: `https://github.com/${handle(short)}`,
        })),
        {
          id: generateObjectId("wlr"),
          orgId: seed.orgId,
          workspaceId: platformId,
          gitUrl: `git@github.com:${handle("other-api")}.git`,
        },
      ])
      for (const short of ["payments-api", "ledger", "other-api", "huge-api"]) {
        const id = generateObjectId("repo")
        await db.insert(repositories).values({
          id,
          orgId: seed.orgId,
          name: handle(short),
          gitUrl: `https://github.com/${handle(short)}.git`,
        })
        await db.insert(repositoryCheckouts).values({
          id: generateObjectId("checkout"),
          orgId: seed.orgId,
          repositoryId: id,
          checkoutKey: "default",
          ref: "main",
          commitSha: sha2,
        })
        seeded.set(short, id)
      }
    })
    // Another org with a Workspace of the same slug and a unit that the
    // first org must never read.
    await withOrgDbContext(foreignOrg.id, async (db) => {
      await db.insert(workspaces).values({
        id: foreignWorkspaceId,
        orgId: foreignOrg.id,
        slug: "foreign-only",
        displayName: "Foreign",
        workspaceRepositoryUrl: `/tmp/files-${suffix}-foreign`,
        desiredDefaultBranch: "main",
        activeProjectionSha: sha1,
      })
      await db.insert(workspaceKnowledgeUnits).values({
        servingId: generateObjectId("wku"),
        orgId: foreignOrg.id,
        workspaceId: foreignWorkspaceId,
        path: "knowledge/secret.md",
        body: "foreign secret\n",
        projectionSha: sha1,
      })
    })
  })

  beforeEach(async () => {
    captured = []
    vi.stubEnv("CODESEARCH_URL", CODESEARCH)
    server.use(...codesearch())
    client = await connect()
  })

  afterEach(async () => {
    await client.close()
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    if (!seed) return
    for (const org of [seed.orgId, foreignOrg.id]) {
      await withOrgDbContext(org, async (db) => {
        await db.delete(workspaces).where(eq(workspaces.orgId, org))
        await db.delete(repositories).where(eq(repositories.orgId, org))
      })
    }
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, foreignOrg.id))
    await cleanupSeededOrg(seed)
  })

  describe("read_file", () => {
    it("reads a knowledge unit by its path and states the served revision", async () => {
      const result = await call("read_file", {
        ref: "knowledge/services/payments-api.md",
      })
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toEqual({
        ref: "knowledge/services/payments-api.md",
        served: { branch: "main", sha: sha1 },
        frontMatter: { source: "authored", updatedAt: expect.any(String) },
        content: "# Payments API\n\nOwns card charges.\nCalls the ledger.",
        startLine: 1,
        endLine: 4,
        totalLines: 4,
        nextStartLine: null,
        truncated: false,
      })
      expect(captured).toEqual([])
    })

    it("reads a path with a colon as a unit when the part before the colon is not a handle", async () => {
      const result = await call("read_file", {
        ref: "slack/threads/c1:1728.md",
      })
      expect(result.structuredContent).toMatchObject({
        ref: "slack/threads/c1:1728.md",
        content: "A thread about limits.",
      })
    })

    it("reads a repository file by handle:path from the published checkout", async () => {
      const result = await call("read_file", {
        ref: `${handle("payments-api")}:src/limits.ts`,
      })
      expect(result.structuredContent).toEqual({
        ref: `${handle("payments-api")}:src/limits.ts`,
        served: { branch: "main", sha: sha2 },
        content: "export const LIMIT = 100\nexport const MAX = 5",
        startLine: 1,
        endLine: 2,
        totalLines: 2,
        nextStartLine: null,
        truncated: false,
      })
      expect(captured.map((request) => request.path)).toEqual([
        `/${seeded.get("payments-api")}/files-query`,
      ])
    })

    it("accepts the host/owner/name and git URL forms of a handle and answers with the handle", async () => {
      const result = await call("read_file", {
        ref: `github.com/${handle("payments-api")}:README.md`,
      })
      expect(result.structuredContent).toMatchObject({
        ref: `${handle("payments-api")}:README.md`,
        content: "# payments-api",
      })
    })

    it("pages a long file with nextStartLine and gives each line once", async () => {
      const lines: string[] = []
      let startLine: number | null = 1
      let pages = 0
      while (startLine !== null) {
        const result = await call("read_file", {
          ref: "knowledge/big.md",
          startLine,
        })
        expect(result.isError).toBeFalsy()
        expect(JSON.stringify(result).length).toBeLessThan(HARD_CAP_CHARS)
        const page = result.structuredContent as {
          content: string
          startLine: number
          endLine: number
          totalLines: number
          nextStartLine: number | null
        }
        expect(page.startLine).toBe(startLine)
        expect(page.totalLines).toBe(600)
        lines.push(...page.content.split("\n"))
        expect(lines).toHaveLength(page.endLine)
        startLine = page.nextStartLine
        pages += 1
      }
      expect(pages).toBeGreaterThan(1)
      expect(lines).toEqual(BIG_LINES)
    })

    it("reads only the asked line range", async () => {
      const result = await call("read_file", {
        ref: "knowledge/big.md",
        startLine: 10,
        endLine: 12,
      })
      expect(result.structuredContent).toMatchObject({
        content: BIG_LINES.slice(9, 12).join("\n"),
        startLine: 10,
        endLine: 12,
        totalLines: 600,
        // The asked range ends here; totalLines tells that more lines exist.
        nextStartLine: null,
      })
    })

    it("cuts a line that is over the budget and stays under the hard cap", async () => {
      const result = await call("read_file", { ref: "knowledge/long-line.md" })
      expect(result.isError).toBeFalsy()
      expect(JSON.stringify(result).length).toBeLessThan(HARD_CAP_CHARS)
      expect(result.structuredContent).toMatchObject({
        startLine: 1,
        endLine: 1,
        truncated: true,
        nextStartLine: null,
      })
    })

    it("refuses an excluded repository before it calls codesearch", async () => {
      const result = await call("read_file", {
        ref: `${handle("payments-api")}:src/limits.ts`,
        excludeRepositories: [`git@github.com:${handle("payments-api")}.git`],
      })
      expect(errorCode(result)).toBe("excluded_repository")
      expect(captured).toEqual([])
    })

    it("reads a unit when the call excludes a repository", async () => {
      const result = await call("read_file", {
        ref: "knowledge/runbooks/deploy.md",
        excludeRepositories: [handle("payments-api")],
      })
      expect(result.structuredContent).toMatchObject({
        content: "# Deploy\n\nRun the pipeline.",
      })
    })

    it("reads a prefix as a unit path when the Workspace does not link that repository", async () => {
      const result = await call("read_file", {
        ref: `${handle("other-api")}:README.md`,
      })
      expect(errorCode(result)).toBe("unknown_ref")
      expect(captured).toEqual([])
    })

    it("reads a repository file with no workspace, at org level, from the published checkout", async () => {
      const result = await call("read_file", {
        workspace: undefined,
        ref: `${handle("other-api")}:README.md`,
      })
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({
        ref: `${handle("other-api")}:README.md`,
        served: { branch: "main", sha: sha2 },
        content: "# other",
      })
      expect(
        errorCode(
          await call("read_file", {
            workspace: undefined,
            ref: "knowledge/runbooks/deploy.md",
          }),
        ),
      ).toBe("invalid_argument")
    })

    it("sends the served SHA to the repository read", async () => {
      await call("read_file", {
        ref: `${handle("payments-api")}:README.md`,
      })
      expect(captured[0]?.claims).toMatchObject({
        repositoryRevisions: [{ sha: sha2 }],
      })
    })

    it.each([
      ".git/config",
      "src/.git/hooks/pre-commit",
    ])("refuses the .git path %j in a repository ref", async (path) => {
      const result = await call("read_file", {
        ref: `${handle("payments-api")}:${path}`,
      })
      expect(errorCode(result)).toBe("invalid_ref")
      expect(captured).toEqual([])
    })

    it("counts the front matter in the lines of a unit, as search_knowledge does", async () => {
      const [chunk] = knowledgeChunkRows(
        [
          {
            servingId: "unit",
            body: FRONT_MATTER_UNIT.body,
            title: "Rate limits",
            bodyStartLine: FRONT_MATTER_UNIT.bodyStartLine,
          },
        ],
        "test-model",
      )
      const result = await call("read_file", { ref: FRONT_MATTER_UNIT.path })
      expect(result.structuredContent).toEqual({
        ref: FRONT_MATTER_UNIT.path,
        // The row of the unit, not the Workspace, states the revision.
        served: { branch: "main", sha: sha2 },
        // The front matter is its own field, not lines of content.
        frontMatter: {
          kind: "Standard",
          title: "Rate limits",
          source: "authored",
          updatedAt: "2026-09-01T00:00:00.000Z",
          claims: [
            {
              to: "knowledge/services/gateway.md",
              predicate: "APPLIES_TO",
              confidence: 0.9,
            },
          ],
        },
        content: "# Rate limits\n\nThe gateway allows 100 calls.",
        startLine: chunk?.startLine,
        endLine: 6,
        totalLines: 6,
        nextStartLine: null,
        truncated: false,
      })
      expect(chunk?.startLine).toBe(4)
      const range = await call("read_file", {
        ref: FRONT_MATTER_UNIT.path,
        startLine: 6,
        endLine: 6,
      })
      expect(range.structuredContent).toMatchObject({
        content: "The gateway allows 100 calls.",
        startLine: 6,
        endLine: 6,
      })
      // A later page does not repeat the front matter.
      expect(range.structuredContent).not.toHaveProperty("frontMatter")
      expect(
        errorCode(
          await call("read_file", {
            ref: FRONT_MATTER_UNIT.path,
            startLine: 1,
            endLine: 3,
          }),
        ),
      ).toBe("invalid_argument")
    })

    it("fits lines full of quotes and backslashes in the hard cap, and loses no line in a page walk", async () => {
      const lines: string[] = []
      let startLine: number | null = 1
      let pages = 0
      while (startLine !== null) {
        const result = await call("read_file", {
          ref: "knowledge/quotes.md",
          startLine,
        })
        expect(result.isError).toBeFalsy()
        expect(JSON.stringify(result).length).toBeLessThanOrEqual(
          HARD_CAP_CHARS,
        )
        const page = result.structuredContent as {
          content: string
          nextStartLine: number | null
          truncated: boolean
        }
        expect(page.truncated).toBe(false)
        lines.push(...page.content.split("\n"))
        startLine = page.nextStartLine
        pages += 1
      }
      expect(pages).toBeGreaterThan(1)
      expect(lines).toEqual(QUOTE_LINES)
    })

    it("gives workspace_not_ready for a linked repository with no index", async () => {
      const result = await call("read_file", {
        ref: `${handle("unindexed")}:README.md`,
      })
      expect(errorCode(result)).toBe("workspace_not_ready")
      expect(captured).toEqual([])
    })

    it.each([
      "knowledge/../secrets.md",
      "/etc/passwd",
      "../../etc/passwd",
      `${handle("payments-api")}:../../etc/passwd`,
      `${handle("payments-api")}:/etc/passwd`,
      `${handle("payments-api")}:src//limits.ts`,
    ])("refuses the path traversal %j before any read", async (ref) => {
      const result = await call("read_file", { ref })
      expect(errorCode(result)).toBe("invalid_ref")
      expect(captured).toEqual([])
    })

    it("gives unknown_ref for a file that the checkout does not give, as a symlink out of the checkout", async () => {
      const result = await call("read_file", {
        ref: `${handle("payments-api")}:escape-link.txt`,
      })
      expect(errorCode(result)).toBe("unknown_ref")
    })

    it("refuses a binary repository file", async () => {
      const result = await call("read_file", {
        ref: `${handle("payments-api")}:logo.png`,
      })
      expect(errorCode(result)).toBe("invalid_argument")
    })

    it("gives unknown_ref for a unit that the projection does not hold", async () => {
      const result = await call("read_file", { ref: "knowledge/missing.md" })
      expect(errorCode(result)).toBe("unknown_ref")
    })

    it("never reads a unit of another org", async () => {
      expect(
        errorCode(await call("read_file", { ref: "knowledge/secret.md" })),
      ).toBe("unknown_ref")
      expect(
        errorCode(
          await call("read_file", {
            workspace: "foreign-only",
            ref: "knowledge/secret.md",
          }),
        ),
      ).toBe("workspace_not_found")
      expect(
        errorCode(
          await call("read_file", {
            org: foreignOrg.slug,
            workspace: "foreign-only",
            ref: "knowledge/secret.md",
          }),
        ),
      ).toBe("org_not_found")
    })

    it("gives workspace_not_ready before the first projection", async () => {
      const result = await call("read_file", {
        workspace: "platform",
        ref: "knowledge/a.md",
      })
      expect(errorCode(result)).toBe("workspace_not_ready")
    })

    it("refuses an endLine before the startLine", async () => {
      const result = await call("read_file", {
        ref: "knowledge/big.md",
        startLine: 5,
        endLine: 4,
      })
      expect(errorCode(result)).toBe("invalid_argument")
    })
  })

  describe("list_files", () => {
    it("lists two folder levels of the Workspace repository with sizes and unit counts", async () => {
      const size = (path: string) => Buffer.byteLength(UNITS[path] ?? "")
      const root = await call("list_files", {})
      expect(root.structuredContent).toEqual({
        repository: null,
        path: "",
        served: { branch: "main", sha: sha1 },
        entries: [
          { path: "knowledge", type: "dir", units: 6 },
          {
            path: "knowledge/big.md",
            type: "file",
            ref: "knowledge/big.md",
            size: size("knowledge/big.md"),
          },
          {
            path: "knowledge/front-matter.md",
            type: "file",
            ref: "knowledge/front-matter.md",
            size: Buffer.byteLength(FRONT_MATTER_UNIT.body),
          },
          {
            path: "knowledge/long-line.md",
            type: "file",
            ref: "knowledge/long-line.md",
            size: size("knowledge/long-line.md"),
          },
          {
            path: "knowledge/quotes.md",
            type: "file",
            ref: "knowledge/quotes.md",
            size: size("knowledge/quotes.md"),
          },
          { path: "knowledge/runbooks", type: "dir", units: 1 },
          { path: "knowledge/services", type: "dir", units: 1 },
          { path: "slack", type: "dir", units: 1 },
          { path: "slack/threads", type: "dir", units: 1 },
        ],
      })
      const knowledge = await call("list_files", {
        path: "knowledge/",
        depth: 1,
      })
      expect(knowledge.structuredContent).toMatchObject({
        path: "knowledge",
        entries: [
          { path: "knowledge/big.md", type: "file" },
          { path: "knowledge/front-matter.md", type: "file" },
          { path: "knowledge/long-line.md", type: "file" },
          { path: "knowledge/quotes.md", type: "file" },
          { path: "knowledge/runbooks", type: "dir", units: 1 },
          { path: "knowledge/services", type: "dir", units: 1 },
        ],
      })
      const runbooks = await call("list_files", {
        path: "knowledge",
        depth: 5,
        glob: "**/d*.md",
      })
      expect(runbooks.structuredContent).toMatchObject({
        entries: [
          {
            path: "knowledge/runbooks/deploy.md",
            type: "file",
            size: size("knowledge/runbooks/deploy.md"),
          },
        ],
      })
      expect((await call("list_files", { depth: 6 })).isError).toBe(true)
      expect(captured).toEqual([])
    })

    it("lists two folder levels of a linked repository with handle:path refs", async () => {
      const result = await call("list_files", {
        repository: `https://github.com/${handle("payments-api")}.git`,
      })
      expect(result.structuredContent).toEqual({
        repository: handle("payments-api"),
        path: "",
        served: { branch: "main", sha: sha2 },
        entries: [
          {
            path: "README.md",
            type: "file",
            ref: `${handle("payments-api")}:README.md`,
          },
          { path: "src", type: "dir" },
          {
            path: "src/index.ts",
            type: "file",
            ref: `${handle("payments-api")}:src/index.ts`,
          },
          {
            path: "src/limits.ts",
            type: "file",
            ref: `${handle("payments-api")}:src/limits.ts`,
          },
        ],
      })
      expect(captured.at(-1)?.body).toMatchObject({ pattern: "{*,*/*}" })
      const globbed = await call("list_files", {
        repository: handle("payments-api"),
        glob: "src/l*.ts",
      })
      expect(
        (
          globbed.structuredContent as { entries: Array<{ path: string }> }
        ).entries.map((entry) => entry.path),
      ).toEqual(["src/limits.ts"])
      const src = await call("list_files", {
        repository: handle("payments-api"),
        path: "src",
      })
      const refs = (
        src.structuredContent as { entries: Array<{ ref?: string }> }
      ).entries.map((entry) => entry.ref)
      for (const ref of refs) {
        const read = await call("read_file", { ref })
        expect(read.isError).toBeFalsy()
      }
    })

    it("pages a large folder with a cursor and lists each entry once", async () => {
      const seen: string[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        const result = await call("list_files", {
          workspace: "paging",
          path: "knowledge/many",
          limit: 10,
          ...(cursor ? { cursor } : {}),
        })
        const page = result.structuredContent as {
          entries: Array<{ path: string }>
          cursor?: string
        }
        seen.push(...page.entries.map((entry) => entry.path))
        cursor = page.cursor
        pages += 1
      } while (cursor)
      expect(pages).toBe(3)
      expect(seen).toEqual(MANY)
    })

    it("fits 100 entries with 55-character paths in the hard cap and pages each once", async () => {
      expect(WIDE[0]).toHaveLength(55)
      const seen: string[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        const result = await call("list_files", {
          workspace: "paging",
          path: "knowledge/wide",
          limit: 100,
          ...(cursor ? { cursor } : {}),
        })
        expect(result.isError).toBeFalsy()
        expect(JSON.stringify(result).length).toBeLessThanOrEqual(
          HARD_CAP_CHARS,
        )
        const page = result.structuredContent as {
          entries: Array<{ path: string }>
          cursor?: string
        }
        seen.push(...page.entries.map((entry) => entry.path))
        cursor = page.cursor
        pages += 1
      } while (cursor)
      expect(pages).toBeGreaterThan(1)
      expect(seen).toEqual(WIDE)
    })

    it("returns truncated when codesearch has more entries than one listing", async () => {
      const result = await call("list_files", {
        repository: handle("huge-api"),
      })
      expect(result.structuredContent).toMatchObject({
        repository: handle("huge-api"),
        truncated: true,
      })
      expect(captured[0]?.body).toMatchObject({
        pattern: "{*,*/*}",
        limit: 5_000,
      })
    })

    it("refuses a .git folder of a repository", async () => {
      const result = await call("list_files", {
        repository: handle("payments-api"),
        path: ".git/objects",
      })
      expect(errorCode(result)).toBe("invalid_ref")
      expect(captured).toEqual([])
    })

    it("gives stale_cursor after a new projection", async () => {
      const first = await call("list_files", {
        workspace: "paging",
        path: "knowledge/many",
        limit: 10,
      })
      const cursor = (first.structuredContent as { cursor: string }).cursor
      await withOrgDbContext(seed.orgId, (db) =>
        db
          .update(workspaces)
          .set({ activeProjectionSha: sha2 })
          .where(eq(workspaces.id, pagingId)),
      )
      try {
        const result = await call("list_files", {
          workspace: "paging",
          path: "knowledge/many",
          limit: 10,
          cursor,
        })
        expect(errorCode(result)).toBe("stale_cursor")
      } finally {
        await withOrgDbContext(seed.orgId, (db) =>
          db
            .update(workspaces)
            .set({ activeProjectionSha: sha1 })
            .where(eq(workspaces.id, pagingId)),
        )
      }
    })

    it("refuses an excluded repository before it calls codesearch", async () => {
      const result = await call("list_files", {
        repository: handle("payments-api"),
        excludeRepositories: [`https://github.com/${handle("payments-api")}`],
      })
      expect(errorCode(result)).toBe("excluded_repository")
      expect(captured).toEqual([])
    })

    it("refuses a repository that the Workspace does not link", async () => {
      const result = await call("list_files", {
        repository: handle("other-api"),
      })
      expect(errorCode(result)).toBe("repository_not_found")
      expect(captured).toEqual([])
    })

    it.each([
      "../",
      "knowledge/../..",
      "/etc",
    ])("refuses the folder %j before any read", async (path) => {
      for (const repository of [undefined, handle("payments-api")]) {
        const result = await call("list_files", {
          path,
          ...(repository ? { repository } : {}),
        })
        expect(errorCode(result)).toBe("invalid_ref")
      }
      expect(captured).toEqual([])
    })

    it("gives unknown_ref for a folder that does not exist", async () => {
      expect(
        errorCode(await call("list_files", { path: "nothing-here" })),
      ).toBe("unknown_ref")
      expect(
        errorCode(
          await call("list_files", {
            repository: handle("payments-api"),
            path: "nothing-here",
          }),
        ),
      ).toBe("unknown_ref")
    })

    it("never lists a unit of another org", async () => {
      const result = await call("list_files", { path: "knowledge" })
      const paths = (
        result.structuredContent as { entries: Array<{ path: string }> }
      ).entries.map((entry) => entry.path)
      expect(paths).not.toContain("knowledge/secret.md")
      expect(
        errorCode(await call("list_files", { workspace: "foreign-only" })),
      ).toBe("workspace_not_found")
    })
  })
})
