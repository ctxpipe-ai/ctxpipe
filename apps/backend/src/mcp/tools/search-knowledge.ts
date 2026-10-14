import { encode } from "@toon-format/toon"
import { z } from "zod"
import { searchKnowledge } from "../../domain/workspaces/knowledge-search.js"
import { pageWithinBudget, truncateText } from "../framework/budget.js"
import {
  listOrgWorkspaceSlugs,
  requireServed,
  resolveCallWorkspace,
} from "../framework/call-workspace.js"
import { decodeCursor, encodeCursor } from "../framework/cursor.js"
import { defineMcpReadTool } from "../framework/tool-registry.js"

const servedSchema = z.object({ branch: z.string(), sha: z.string() })
const hitSchema = z.object({
  workspace: z.string(),
  ref: z.string(),
  title: z.string().nullable(),
  kind: z.string().nullable(),
  source: z.string(),
  updatedAt: z.string(),
  snippet: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  score: z.number(),
  served: servedSchema,
})

/** Register this tool at the seven-tool cutover (ADR-051). */
export const searchKnowledgeTool = defineMcpReadTool({
  name: "search_knowledge",
  title: "Search knowledge",
  description:
    "Search knowledge before a design choice. Returns the best chunk of each matching unit with a file ref. Send independent calls in parallel.",
  org: "required",
  inputShape: {
    query: z.string().trim().min(1).max(4_000),
    workspaces: z.array(z.string().min(1).max(64)).min(1).max(8).optional(),
    kinds: z.array(z.string().min(1)).max(50).optional(),
    pathPrefix: z.string().max(1_024).optional(),
    sources: z.array(z.string().min(1)).max(50).optional(),
    updatedAfter: z.iso.datetime({ offset: true }).optional(),
    validAt: z.iso.datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(50).default(10),
    cursor: z.string().max(2_048).optional(),
  },
  outputSchema: z.object({
    hits: z.array(hitSchema),
    cursor: z.string().optional(),
    truncated: z.boolean().optional(),
  }),
  async run(input, { org }) {
    const workspaces = await Promise.all(
      [...new Set(input.workspaces ?? (await listOrgWorkspaceSlugs(org)))]
        .sort()
        .map((slug) => resolveCallWorkspace(org, slug)),
    )
    for (const workspace of workspaces) requireServed(workspace)
    const hits = await searchKnowledge({
      orgId: org.id,
      workspaceIds: workspaces.map((w) => w.id),
      query: input.query,
      kinds: input.kinds,
      pathPrefix: input.pathPrefix,
      sources: input.sources,
      updatedAfter: input.updatedAfter
        ? new Date(input.updatedAfter)
        : undefined,
      validAt: input.validAt ? new Date(input.validAt) : undefined,
      limit: 50,
    })
    const { cursor, ...parameters } = input
    const binding = {
      orgId: org.id,
      workspaceId: null,
      scope: JSON.stringify(["search_knowledge", parameters]),
      sha: JSON.stringify([
        workspaces.map((workspace) => [
          workspace.id,
          requireServed(workspace).sha,
        ]),
        [
          ...new Set(
            hits.map((hit) => `${hit.workspaceId}:${hit.projectionSha}`),
          ),
        ].sort(),
      ]),
    }
    const offset = cursor ? decodeCursor(cursor, binding) : 0
    const items = hits.map((hit) => {
      const workspace = workspaces.find((w) => w.id === hit.workspaceId)
      if (!workspace) throw new Error("Search returned an unknown Workspace")
      return {
        workspace: workspace.slug,
        ref: hit.path,
        title: hit.title,
        kind: hit.kind,
        source: hit.source,
        updatedAt: hit.updatedAt.toISOString(),
        snippet: truncateText(hit.text, 3_000),
        startLine: hit.startLine,
        endLine: hit.endLine,
        score: hit.score,
        served: { ...requireServed(workspace), sha: hit.projectionSha },
      }
    })
    // The wire holds the TOON text and the JSON, so one item costs both.
    const { page, nextOffset, truncated } = pageWithinBudget(items, {
      offset,
      limit: input.limit,
      maxTokens: 5_000,
      measure: (item) => encode(item) + JSON.stringify(item),
    })
    return {
      hits: page,
      ...(nextOffset === null
        ? {}
        : { cursor: encodeCursor({ ...binding, offset: nextOffset }) }),
      ...(truncated ? { truncated: true } : {}),
    }
  },
})
