import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { and, eq } from "drizzle-orm"
import { expect, it, vi } from "vitest"

import { getAuth, resetBetterAuthForTests } from "../../auth/config.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { apikeys, members, sessions, users } from "../../db/schema/auth.js"
import { claims } from "../../db/schema/claims.js"
import { objects } from "../../db/schema/objects.js"
import { repositories } from "../../db/schema/repositories.js"
import {
  orgFirstWorkspaces,
  workspaceKnowledgeUnits,
  workspaces,
} from "../../db/schema/workspaces.js"
import { migrateKnowledgeStore } from "../../knowledge-store/migrate.js"
import { getKnowledgeState } from "../../models/knowledge-state.js"
import {
  getWorkspaceProjection,
  persistWorkspaceIndexResult,
} from "../../models/workspaces.js"
import { startClickHouse, userUrl } from "../../test/clickhouse.js"
import { callTool, connectToolClient } from "../../test/mcp-tool-client.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { TOOL_ERROR_META_KEY } from "../framework/tool-result.js"
import { getRelatedTool } from "./get-related.js"
import { listFilesTool } from "./list-files.js"
import { readFileTool } from "./read-file.js"
import { searchKnowledgeTool } from "./search-knowledge.js"

/**
 * Two main-era objects of a GitLab repository, with a claim between them, and
 * an org API key of an admin for the MCP client. Returns the MCP seed and the
 * cleanup.
 */
async function seedMainEraKnowledge(f: NativeHydrationFixture) {
  const repositoryId = `repo_tools_${f.id}`
  const userId = `user_${f.id}`
  const token = `token_${f.id}`
  // Each fixture opens its own database pool; Better Auth keeps the first.
  resetBetterAuthForTests()
  await withOrgDbContext(f.org.id, async (db) => {
    await db.insert(repositories).values({
      id: repositoryId,
      orgId: f.org.id,
      name: "tools",
      gitUrl: "https://gitlab.com/example/tools.git",
    })
    await db.insert(orgFirstWorkspaces).values({
      orgId: f.org.id,
      workspaceId: f.workspaceId,
      sourceRepositoryId: repositoryId,
    })
    await db.insert(objects).values([
      {
        id: `obj_tools_${f.id}`,
        orgId: f.org.id,
        kind: "Service",
        deduplicationKey: `svc:${repositoryId}:tools`,
        payload: {
          name: "Tools CLI",
          summary: "The release tools.",
          path: "cmd/tools/main.go",
        },
      },
      {
        id: `obj_parser_${f.id}`,
        orgId: f.org.id,
        kind: "Library",
        deduplicationKey: `lib:${repositoryId}:parser`,
        payload: { name: "Parser", summary: "Reads the manifest." },
      },
    ])
    await db.insert(claims).values({
      id: `clm_uses_${f.id}`,
      orgId: f.org.id,
      subjectId: `obj_tools_${f.id}`,
      predicate: "USES",
      objectId: `obj_parser_${f.id}`,
      status: "active",
      firstObservedAt: new Date("2026-01-01T00:00:00Z"),
      lastObservedAt: new Date("2026-01-01T00:00:00Z"),
      aggregatedConfidence: 0.9,
    })
  })
  // An org API key for the MCP client, made by an admin session.
  await getSystemDb()
    .insert(users)
    .values({ id: userId, name: "Admin", email: `${f.id}@example.test` })
  await getSystemDb()
    .insert(members)
    .values({
      id: `mem_${f.id}`,
      organizationId: f.org.id,
      userId,
      role: "admin",
      createdAt: new Date(),
    })
  await getSystemDb()
    .insert(sessions)
    .values({
      id: `ses_${f.id}`,
      token,
      userId,
      activeOrganizationId: f.org.id,
      expiresAt: new Date(Date.now() + 86_400_000),
      updatedAt: new Date(),
    })
  const key = await getAuth().api.createApiKey({
    body: {
      configId: "organization",
      name: "legacy-knowledge",
      organizationId: f.org.id,
    },
    headers: new Headers({ authorization: `Bearer ${token}` }),
  })
  const clients: Client[] = []
  return {
    /** An MCP client of one tool, closed by `cleanup`. */
    client: async (tool: Parameters<typeof connectToolClient>[1]) => {
      const connected = await connectToolClient({ orgApiKey: key.key }, tool)
      clients.push(connected)
      return connected
    },
    cleanup: async () => {
      for (const connected of clients) await connected.close()
      await withOrgDbContext(f.org.id, async (db) => {
        await db.delete(claims).where(eq(claims.orgId, f.org.id))
        await db.delete(objects).where(eq(objects.orgId, f.org.id))
      })
      await getSystemDb()
        .delete(apikeys)
        .where(eq(apikeys.referenceId, f.org.id))
      await getSystemDb().delete(users).where(eq(users.id, userId))
    },
  }
}

/** The `{ code, message, retryable }` of a tool error result. */
const toolError = (result: CallToolResult) =>
  result._meta?.[TOOL_ERROR_META_KEY]

/** The legacy overlay count that the hydrate wrote on the Workspace row. */
async function legacyKnowledgeFiles(f: NativeHydrationFixture) {
  const [row] = await withOrgDbContext(f.org.id, (db) =>
    db
      .select({ files: workspaces.legacyKnowledgeFiles })
      .from(workspaces)
      .where(eq(workspaces.id, f.workspaceId)),
  )
  return row?.files
}

/** Publish the hydrated revision, so that the read tools serve it. */
async function publishIndex(f: NativeHydrationFixture) {
  await withOrgIdContext(f.org, async () => {
    const active = await getWorkspaceProjection(f.workspaceId)
    if (active.kind !== "active") throw new Error("Expected a projection")
    await persistWorkspaceIndexResult({
      revision: active.revision,
      result: { kind: "ready" },
    })
  })
}

/**
 * The knowledge plane projects only the Workspace repository, so it does not
 * serve the main-era knowledge (the CTO, 2026-11-26). Each knowledge tool
 * says that the knowledge is missing, and what an owner or admin does about
 * it, not a silent miss (CTX-1715).
 */
it(
  "each knowledge tool names the main-era knowledge that it does not serve, and the action",
  { timeout: 240_000 },
  async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    const clickhouse = await startClickHouse()
    try {
      const adminUrl = await clickhouse.freshDatabase()
      await migrateKnowledgeStore(adminUrl, {
        reader: "reader-test",
        writer: "writer-test",
      })
      const writerUrl = userUrl(adminUrl, "ctxpipe_writer", "writer-test")
      await withNativeHydrationFixture(
        { knowledgePlane: { clickhouseUrl: writerUrl } },
        async (f) => {
          const mainEra = await seedMainEraKnowledge(f)
          try {
            await f.worker.start()
            expect(await f.handle.result({ timeoutMs: 60_000 })).toMatchObject({
              hydrated: true,
              units: f.count + 2,
            })
            expect(await legacyKnowledgeFiles(f)).toBe(2)
            await publishIndex(f)
            // The plane projects the Workspace repository at the tip.
            await vi.waitFor(
              async () =>
                expect(
                  await getKnowledgeState({
                    orgId: f.org.id,
                    workspaceId: f.workspaceId,
                  }),
                ).toMatchObject({ lastSha: f.sha, runStatus: "completed" }),
              { timeout: 120_000, interval: 250 },
            )
            const { client } = mainEra
            const args = { org: f.org.slug, workspace: "knowledge" }
            const message = `Workspace "knowledge" has 2 knowledge files from before Workspaces that are not in its repository, so ctxpipe does not serve them. An owner or admin of the org can add them: merge the format upgrade if the Workspace has one open, then start the re-ingestion (Workspace settings, Upgrades).`
            const notices = [
              {
                workspace: "knowledge",
                files: 2,
                message,
              },
            ]

            const search = await callTool(
              await client(searchKnowledgeTool),
              "search_knowledge",
              { ...args, workspaces: ["knowledge"], query: "release tools" },
            )
            expect(search.isError).not.toBe(true)
            expect(search.structuredContent?.notices).toEqual(notices)
            expect(
              (search.structuredContent?.hits as Array<{ title: string }>).map(
                (hit) => hit.title,
              ),
            ).not.toContain("Tools CLI")

            const files = await callTool(
              await client(listFilesTool),
              "list_files",
              args,
            )
            expect(files.isError).not.toBe(true)
            expect(files.structuredContent?.notices).toEqual(notices)

            // The path of the main-era unit in Postgres.
            const [unit] = await withOrgDbContext(f.org.id, (db) =>
              db
                .select({ path: workspaceKnowledgeUnits.path })
                .from(workspaceKnowledgeUnits)
                .where(
                  and(
                    eq(workspaceKnowledgeUnits.workspaceId, f.workspaceId),
                    eq(workspaceKnowledgeUnits.title, "Tools CLI"),
                  ),
                ),
            )
            const ref = unit?.path
            expect(ref).toMatch(/^knowledge\//)
            const read = await callTool(
              await client(readFileTool),
              "read_file",
              { ...args, ref },
            )
            expect(toolError(read)).toEqual({
              code: "unknown_ref",
              message: expect.stringContaining(message),
              retryable: false,
            })

            const related = await callTool(
              await client(getRelatedTool),
              "get_related",
              { ...args, seeds: [ref], intent: "dependencies" },
            )
            expect(toolError(related)).toEqual({
              code: "unknown_ref",
              message: expect.stringContaining(message),
              retryable: false,
            })
          } finally {
            await mainEra.cleanup()
          }
        },
      )
    } finally {
      await clickhouse.stop()
    }
  },
)
