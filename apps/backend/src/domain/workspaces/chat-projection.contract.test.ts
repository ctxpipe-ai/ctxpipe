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
import {
  workspaces,
  workspaceLinkedRepositories,
} from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import {
  captureWorkspaceRevision,
  listOrgLinkedRepositories,
  commitHydrateProjection,
  persistWorkspaceIndexResult,
  getWorkspaceProjectionSnapshot,
} from "../../models/workspaces.js"
import { hydrateKnowledgeTree } from "./hydrate.js"
import type { WorkspaceRevision } from "./revision.js"
import { workspaceChatTools } from "./workspace-chat-tools.js"

type ChatFixture = {
  org: { id: string; slug: string; name: string }
  workspaceId: string
  repositoryId: string
  excludedRepositoryId: string
  revision: WorkspaceRevision
  snapshot: Awaited<ReturnType<typeof getWorkspaceProjectionSnapshot>>
}
async function withChatProjection(
  run: (fixture: ChatFixture) => Promise<void>,
) {
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
      connectionId: null,
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
          checkoutKey: `ws:${workspaceId}:${revision.sha}`,
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
      await run({
        org,
        workspaceId,
        repositoryId,
        excludedRepositoryId,
        revision,
        snapshot: await getWorkspaceProjectionSnapshot(workspaceId),
      })
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
}

it(
  "chat exposes public object schemas without checkout identities",
  { timeout: 30_000 },
  async () => {
    await withChatProjection(async (f) => {
      const tools = await workspaceChatTools({
        ...f,
        orgId: f.org.id,
        orgSlug: f.org.slug,
      })
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          "hybrid_search",
          "search",
          "get_file",
          "glob_files",
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
    })
  },
)

it(
  "chat retains captured repository membership after checkout removal",
  { timeout: 30_000 },
  async () => {
    await withChatProjection(async (f) => {
      await withOrgDbContext(f.org.id, (db) =>
        db
          .delete(repositoryCheckouts)
          .where(eq(repositoryCheckouts.repositoryId, f.repositoryId)),
      )
      const tools = await workspaceChatTools({
        ...f,
        orgId: f.org.id,
        orgSlug: f.org.slug,
      })
      const listed = String(
        await tools.find((t) => t.name === "list_repositories")?.execute({}),
      )
      expect(listed).toContain(f.repositoryId)
      expect(listed).not.toContain(f.excludedRepositoryId)
    })
  },
)

it(
  "chat rejects a repository outside its captured workspace",
  { timeout: 30_000 },
  async () => {
    await withChatProjection(async (f) => {
      const tools = await workspaceChatTools({
        ...f,
        orgId: f.org.id,
        orgSlug: f.org.slug,
      })
      expect(
        String(
          await tools
            .find((t) => t.name === "graph_find_symbol")
            ?.execute({
              repositoryId: f.excludedRepositoryId,
              symbol: "First",
            }),
        ),
      ).toContain("repository_not_in_workspace")
    })
  },
)

it("an absent workspace has no chat tools", { timeout: 30_000 }, async () => {
  await withChatProjection(async (f) => {
    expect(
      await workspaceChatTools({
        ...f,
        orgId: f.org.id,
        orgSlug: f.org.slug,
        snapshot: await getWorkspaceProjectionSnapshot(generateObjectId("ws")),
      }),
    ).toEqual([])
  })
})

it(
  "publishing a changed linked branch invalidates its prior indexed revision",
  { timeout: 30_000 },
  async () => {
    await withChatProjection(async (f) => {
      const linkedId = generateObjectId("wlr")
      await withOrgDbContext(f.org.id, (db) =>
        db.insert(workspaceLinkedRepositories).values({
          id: linkedId,
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          gitUrl: "https://example.test/other",
          desiredRef: "main",
          desiredSha: "c".repeat(40),
          indexedSha: "c".repeat(40),
        }),
      )
      const next = await captureWorkspaceRevision({
        workspaceId: f.workspaceId,
        expected: {
          generation: 1,
          url: f.revision.remote.url,
          sha: f.revision.sha,
          defaultBranch: "main",
          githubConnectionId: null,
        },
        tip: { sha: "b".repeat(40), branch: "main" },
      })
      if (!next) throw new Error("Missing next fixture revision")
      await commitHydrateProjection({
        orgId: f.org.id,
        revision: next,
        units: [],
        remotes: [{ git: "https://example.test/other.git", branch: "release" }],
        displayName: null,
      })
      expect(await listOrgLinkedRepositories(f.org.id)).toMatchObject([
        {
          id: linkedId,
          desiredRef: "release",
          desiredSha: null,
          indexedSha: null,
        },
      ])
    })
  },
)
