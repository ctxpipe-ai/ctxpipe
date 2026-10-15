import { posix } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { evlog } from "evlog/hono"
import { FalkorDB } from "falkordb"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import type { SeededOrg } from "../../test/db.js"
import type { AppEnv } from "../app/env.js"
import { parseEnv } from "../config/env.js"
import { withOrgDbContext } from "../db/client.js"
import { workspaceKnowledgeUnits, workspaces } from "../db/schema/workspaces.js"
import {
  workspaceGraphRevisionKey,
  writeWorkspaceRevisionGraph,
} from "../domain/workspaces/graph-projection.js"
import type { HydrateUnit } from "../domain/workspaces/hydrate.js"
import type { WorkspaceRevision } from "../domain/workspaces/revision.js"
import type { McpReadTool } from "../mcp/framework/tool-registry.js"
import { getGraphClient, withGraphClient } from "../platform/graph/client.js"
import { registerMcpRoutes } from "../routes/mcp.js"
import { withTestRequestLogger } from "./hono-test-logger.js"
import { seedKnowledgeUnits } from "./knowledge-search-fixture.js"

/** One knowledge unit of a fixture Workspace. A claim points to a unit path. */
export type RelatedUnit = {
  path: string
  kind: string
  title?: string
  body?: string
  /** Unit paths that the body links to. Hydrate turns each into a `LINKS_TO` edge. */
  links?: string[]
  claims?: Array<{
    to: string
    predicate: string
    confidence: number
    validFrom?: string
    validTo?: string
  }>
}

/**
 * A Workspace with an active revision, its units in Postgres, and its graph
 * in FalkorDB. `chunks: true` also writes the search chunks and embeddings.
 */
export async function seedRelatedWorkspace(input: {
  seed: SeededOrg
  slug: string
  sha: string
  units: readonly RelatedUnit[]
  chunks?: boolean
}): Promise<{ workspaceId: string; revision: WorkspaceRevision }> {
  const { seed, slug, sha } = input
  const workspaceId = `ws_rel_${slug}_${Date.now().toString(36)}`
  const url = `https://git.example.test/acme/${slug}.git`
  const revision: WorkspaceRevision = {
    workspaceId,
    generation: 1,
    remote: { url, connectionId: null },
    defaultBranch: "main",
    sha,
    access: "read",
  }
  await withOrgDbContext(seed.orgId, (db) =>
    db.insert(workspaces).values({
      id: workspaceId,
      orgId: seed.orgId,
      slug,
      displayName: `Fixture ${slug}`,
      workspaceRepositoryUrl: url,
      desiredDefaultBranch: "main",
      activeProjectionSha: sha,
      activeRevision: revision,
      hydratePhases: {
        url,
        sha,
        revision,
        embeddings: true,
        graph: { revision, result: { kind: "ready" } },
        index: { revision, result: { kind: "ready" } },
      },
    }),
  )
  const servingId = (path: string) => `ku_${workspaceId}_${path}`
  const hydrateUnits: HydrateUnit[] = input.units.map((unit) => ({
    path: unit.path,
    servingId: servingId(unit.path),
    kind: unit.kind,
    body: unit.body ?? `# ${unit.title ?? unit.path}\n`,
    links: (unit.links ?? []).map((to) =>
      posix.relative(posix.dirname(unit.path), to),
    ),
    claims: (unit.claims ?? []).map((claim) => ({
      to: posix.relative(posix.dirname(unit.path), claim.to),
      predicate: claim.predicate,
      confidence: claim.confidence,
      validFrom: claim.validFrom ?? null,
      validTo: claim.validTo ?? null,
      source: null,
    })),
    title: unit.title ?? unit.path,
    source: "authored",
    updatedAt: "2026-09-01T00:00:00.000Z",
  }))
  if (input.chunks) {
    await seedKnowledgeUnits(
      seed.orgId,
      sha,
      input.units.map((unit) => ({
        id: servingId(unit.path),
        workspaceId,
        path: unit.path,
        kind: unit.kind,
        title: unit.title ?? unit.path,
        source: "authored",
        updatedAt: "2026-09-01T00:00:00Z",
        body: unit.body ?? `# ${unit.title ?? unit.path}\n`,
      })),
    )
  } else {
    await withOrgDbContext(seed.orgId, async (db) => {
      for (let start = 0; start < hydrateUnits.length; start += 1_000) {
        await db.insert(workspaceKnowledgeUnits).values(
          hydrateUnits.slice(start, start + 1_000).map((unit) => ({
            servingId: unit.servingId,
            orgId: seed.orgId,
            workspaceId,
            path: unit.path,
            kind: unit.kind ?? null,
            title: unit.title,
            source: unit.source,
            body: unit.body,
            projectionSha: sha,
          })),
        )
      }
    })
  }
  await withGraphClient({ orgId: seed.orgId, orgSlug: seed.orgSlug }, () =>
    writeWorkspaceRevisionGraph(getGraphClient(), {
      revision,
      units: hydrateUnits,
    }),
  )
  return { workspaceId, revision }
}

/** Delete the graph that the org holds in FalkorDB. */
export async function dropOrgGraph(orgId: string): Promise<void> {
  const falkor = await FalkorDB.connect({
    url: parseEnv(process.env).GRAPH_DB_URI,
  })
  try {
    if ((await falkor.list()).includes(orgId))
      await falkor.selectGraph(orgId).delete()
  } finally {
    await falkor.close()
  }
}

/** An MCP client over the real `/mcp` route with one tool registered. */
export async function connectToolClient(
  seed: SeededOrg,
  tool: McpReadTool,
): Promise<Client> {
  const app = new Hono<AppEnv>()
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use(evlog())
  app.use("*", async (c, next) => {
    c.set("env", parseEnv(process.env))
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
  registerMcpRoutes(app, { registerTools: (server) => tool.register(server) })
  const client = new Client({ name: "related-contract", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (url, init) => app.request(String(url), init),
      requestInit: { headers: { "x-api-key": seed.orgApiKey } },
    }),
  )
  await client.listTools()
  return client
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult
}

/** Remove the projection of one revision from the graph store, as a lost graph does. */
export async function deleteRevisionGraph(
  seed: SeededOrg,
  revision: WorkspaceRevision,
): Promise<void> {
  const projectionKey = workspaceGraphRevisionKey(revision)
  await withGraphClient(
    { orgId: seed.orgId, orgSlug: seed.orgSlug },
    async () => {
      const graph = getGraphClient()
      await graph.executeQuery(
        "MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey}) DETACH DELETE n",
        { projectionKey },
      )
      await graph.executeQuery(
        "MATCH (p:WorkspaceProjection {projectionKey: $projectionKey}) DELETE p",
        { projectionKey },
      )
    },
  )
}
