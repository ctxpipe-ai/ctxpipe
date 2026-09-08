import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import {
  captureWorkspaceRevision,
  commitHydrateProjection,
  persistWorkspaceIndexResult,
  getWorkspaceProjectionSnapshot,
} from "../../models/workspaces.js"
import { hydrateKnowledgeTree } from "./hydrate.js"
import type { WorkspaceRevision } from "./revision.js"
import { workspaceChatTools } from "./workspace-chat-tools.js"

it(
  "reads chat graph nodes and neighbors from the captured Postgres projection",
  { timeout: 30_000 },
  async () => {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl)
      throw new Error("DATABASE_URL is required for chat projection proof")
    initDb(databaseUrl)
    const org = {
      id: generateObjectId("org"),
      slug: generateObjectId("slug"),
      name: "Chat projection contract",
    }
    const workspaceId = generateObjectId("ws")
    const revision: WorkspaceRevision = {
      workspaceId,
      generation: 1,
      remote: {
        url: "https://example.test/context.git",
        githubConnectionId: null,
      },
      sha: "a".repeat(40),
      defaultBranch: "main",
      access: "read",
    }
    try {
      await getSystemDb()
        .insert(organizations)
        .values({ ...org, createdAt: new Date() })
      await withOrgDbContext(org.id, (db) =>
        db.insert(workspaces).values({
          id: workspaceId,
          orgId: org.id,
          slug: "context",
          displayName: org.name,
          workspaceRepositoryUrl: revision.remote.url,
          desiredGeneration: 1,
          desiredSha: revision.sha,
          desiredDefaultBranch: "main",
        }),
      )
      await withOrgIdContext(org, async () => {
        const parsed = hydrateKnowledgeTree({
          workspaceId,
          files: [
            {
              path: "first.md",
              content:
                "---\nclaims:\n  - to: second.md\n    predicate: depends_on\n---\n# First published node\n",
            },
            { path: "second.md", content: "# Second published node\n" },
          ],
        })
        expect(parsed.skipped).toEqual([])
        expect(parsed.units[0]?.claims).toHaveLength(1)
        expect(
          await commitHydrateProjection({
            orgId: org.id,
            revision,
            units: parsed.units,
            remotes: [],
            displayName: null,
          }),
        ).toBe(true)
        const repositoryId = generateObjectId("repo")
        const excludedRepositoryId = generateObjectId("repo")
        await withOrgDbContext(org.id, async (db) => {
          await db.insert(repositories).values([
            {
              id: repositoryId,
              orgId: org.id,
              name: "Published",
              gitUrl: revision.remote.url,
            },
            {
              id: excludedRepositoryId,
              orgId: org.id,
              name: "Unrelated",
              gitUrl: "https://example.test/other.git",
            },
          ])
          await db.insert(repositoryCheckouts).values({
            id: generateObjectId("co"),
            orgId: org.id,
            repositoryId,
            checkoutKey: "ws:" + workspaceId,
            ref: revision.sha,
            commitSha: revision.sha,
          })
        })
        expect(
          await persistWorkspaceIndexResult({
            revision,
            result: { kind: "ready" },
          }),
        ).toBe(true)
        const snapshot = await getWorkspaceProjectionSnapshot(workspaceId)
        const first = snapshot.units.find((unit) => unit.path === "first.md")
        const second = snapshot.units.find((unit) => unit.path === "second.md")
        if (!first || !second)
          throw new Error("Missing published fixture units")
        const tools = await workspaceChatTools({
          orgId: org.id,
          workspaceId,
          snapshot,
        })
        expect(tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining([
            "hybrid_search",
            "search",
            "list_repositories",
            "graph_find_symbol",
            "graph_lookup",
            "graph_neighbors",
          ]),
        )
        for (const tool of tools) {
          expect(tool.inputSchema.type).toBe("object")
          expect(tool.inputSchema.properties).not.toHaveProperty("checkoutKey")
        }
        expect(
          tools.some((tool) => ["get_file", "glob_files"].includes(tool.name)),
        ).toBe(false)
        const listed = String(
          await tools
            .find((tool) => tool.name === "list_repositories")
            ?.execute({}),
        )
        expect(listed).toContain(repositoryId)
        expect(listed).not.toContain(excludedRepositoryId)
        expect(
          String(
            await tools
              .find((tool) => tool.name === "graph_find_symbol")
              ?.execute({
                repositoryId: excludedRepositoryId,
                symbol: "First",
              }),
          ),
        ).toContain("repository_not_in_workspace")
        expect(
          await workspaceChatTools({
            orgId: org.id,
            workspaceId,
            snapshot: await getWorkspaceProjectionSnapshot(
              generateObjectId("ws"),
            ),
          }),
        ).toEqual([])
        const lookup = tools.find((tool) => tool.name === "graph_lookup")
        const neighbors = tools.find((tool) => tool.name === "graph_neighbors")
        expect(lookup).toBeDefined()
        expect(neighbors).toBeDefined()
        expect(
          String(await lookup?.execute({ nodeId: first.servingId })),
        ).toContain("First published node")
        expect(
          String(await neighbors?.execute({ nodeId: first.servingId })),
        ).toContain(second.servingId)
        expect(
          String(await neighbors?.execute({ nodeId: second.servingId })),
        ).toContain(first.servingId)
        expect(
          String(await lookup?.execute({ nodeId: "kn_foreign" })),
        ).toContain("null")
        expect(
          String(await neighbors?.execute({ nodeId: "kn_foreign" })),
        ).not.toContain(first.servingId)
        const nextRevision = { ...revision, sha: "b".repeat(40) }
        expect(
          await captureWorkspaceRevision({
            workspaceId,
            expected: {
              generation: 1,
              url: revision.remote.url,
              sha: revision.sha,
              defaultBranch: "main",
              githubConnectionId: null,
            },
            tip: { sha: nextRevision.sha, branch: "main" },
          }),
        ).toEqual(nextRevision)
        const nextUnits = hydrateKnowledgeTree({
          workspaceId,
          files: [{ path: "first.md", content: "# Replacement node\n" }],
        }).units
        expect(
          await commitHydrateProjection({
            orgId: org.id,
            revision: nextRevision,
            units: nextUnits,
            remotes: [],
            displayName: null,
          }),
        ).toBe(true)
        expect(
          String(await lookup?.execute({ nodeId: first.servingId })),
        ).toContain("First published node")
        expect(
          String(await neighbors?.execute({ nodeId: first.servingId })),
        ).toContain(second.servingId)
        const nextTools = await workspaceChatTools({
          orgId: org.id,
          workspaceId,
          snapshot: await getWorkspaceProjectionSnapshot(workspaceId),
        })
        expect(
          String(
            await nextTools
              .find((tool) => tool.name === "graph_lookup")
              ?.execute({ nodeId: first.servingId }),
          ),
        ).toContain("Replacement node")
        expect(
          String(
            await nextTools
              .find((tool) => tool.name === "graph_neighbors")
              ?.execute({ nodeId: first.servingId }),
          ),
        ).not.toContain(second.servingId)
      })
    } finally {
      await withOrgDbContext(org.id, async (db) => {
        await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
        await db.delete(repositories).where(eq(repositories.orgId, org.id))
      })
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, org.id))
      await closeDb()
    }
  },
)
