import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { getAuth } from "../../auth/config.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { apikeys, members, sessions, users } from "../../db/schema/auth.js"
import { claims } from "../../db/schema/claims.js"
import { objects } from "../../db/schema/objects.js"
import { repositories } from "../../db/schema/repositories.js"
import { orgFirstWorkspaces } from "../../db/schema/workspaces.js"
import {
  getWorkspaceProjection,
  persistWorkspaceIndexResult,
} from "../../models/workspaces.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { callTool, connectToolClient } from "../../test/related-fixture.js"
import { getRelatedTool } from "./get-related.js"
import { listFilesTool } from "./list-files.js"
import { listWorkspaces } from "./list-workspaces.js"
import { readFileTool } from "./read-file.js"
import { searchKnowledgeTool } from "./search-knowledge.js"

/**
 * CTX-642: below format 3 no ingestion runs. The read tools serve the
 * main-era knowledge that Postgres holds for a Workspace at format 0.
 */
it(
  "serves the main-era objects of a format 0 Workspace through each knowledge tool",
  { timeout: 120_000 },
  async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    if (!process.env.GRAPH_DB_URI) throw new Error("GRAPH_DB_URI is required")
    await withNativeHydrationFixture({}, async (f) => {
      const repositoryId = `repo_tools_${f.id}`
      const userId = `user_${f.id}`
      const token = `token_${f.id}`
      const clients: Client[] = []
      try {
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
        const seed = { orgApiKey: key.key }

        await f.worker.start()
        expect(await f.handle.result({ timeoutMs: 60_000 })).toMatchObject({
          hydrated: true,
          units: f.count + 2,
        })
        await withOrgIdContext(f.org, async () => {
          const active = await getWorkspaceProjection(f.workspaceId)
          if (active.kind !== "active") throw new Error("Expected a projection")
          await persistWorkspaceIndexResult({
            revision: active.revision,
            result: { kind: "ready" },
          })
        })

        const client = async (
          tool: Parameters<typeof connectToolClient>[1],
        ) => {
          const connected = await connectToolClient(seed, tool)
          clients.push(connected)
          return connected
        }
        const args = { org: f.org.slug, workspace: "knowledge" }

        const listed = await callTool(
          await client(listWorkspaces),
          "list_workspaces",
          args,
        )
        expect(listed.isError).not.toBe(true)
        expect(listed.structuredContent?.units).toMatchObject({
          Service: 1,
          Library: 1,
        })

        const files = await callTool(
          await client(listFilesTool),
          "list_files",
          { ...args, path: "knowledge", depth: 5, glob: "**/*.md" },
        )
        expect(files.isError).not.toBe(true)
        const refs = (
          files.structuredContent?.entries as Array<{ path: string }>
        ).map((entry) => entry.path)
        const toolsPath = refs.find((path) => path.endsWith("tools-cli.md"))
        const parserPath = refs.find((path) => path.endsWith("parser.md"))
        expect(toolsPath).toMatch(/^knowledge\//)
        expect(parserPath).toMatch(/^knowledge\//)

        const search = await callTool(
          await client(searchKnowledgeTool),
          "search_knowledge",
          { ...args, workspaces: ["knowledge"], query: "release tools" },
        )
        expect(search.isError).not.toBe(true)
        expect(search.structuredContent?.hits).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ ref: toolsPath, title: "Tools CLI" }),
          ]),
        )

        const read = await callTool(await client(readFileTool), "read_file", {
          ...args,
          ref: toolsPath,
        })
        expect(read.isError).not.toBe(true)
        expect(JSON.stringify(read.structuredContent)).toContain(
          "The release tools.",
        )

        const related = await callTool(
          await client(getRelatedTool),
          "get_related",
          { ...args, seeds: [toolsPath], intent: "dependencies" },
        )
        expect(related.isError).not.toBe(true)
        expect(
          (related.structuredContent?.results as Array<{ ref: string }>).map(
            (result) => result.ref,
          ),
        ).toContain(parserPath)
      } finally {
        for (const connected of clients) await connected.close()
        await withOrgDbContext(f.org.id, async (db) => {
          await db.delete(claims).where(eq(claims.orgId, f.org.id))
          await db.delete(objects).where(eq(objects.orgId, f.org.id))
        })
        await getSystemDb()
          .delete(apikeys)
          .where(eq(apikeys.referenceId, f.org.id))
        await getSystemDb().delete(users).where(eq(users.id, userId))
      }
    })
  },
)
