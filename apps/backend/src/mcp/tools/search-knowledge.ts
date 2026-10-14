import { z } from "zod"
import { searchKnowledge } from "../../domain/workspaces/knowledge-search.js"
import { fitPage, truncateText } from "../framework/budget.js"
import {
  listOrgWorkspaceSlugs,
  requireServed,
  resolveCallWorkspace,
} from "../framework/call-workspace.js"
import { decodeCursor, encodeCursor } from "../framework/cursor.js"
import {
  type Skipped,
  servedSchema,
  skippedSchema,
} from "../framework/schemas.js"
import { McpToolError } from "../framework/tool-errors.js"
import { defineMcpReadTool } from "../framework/tool-registry.js"

/** Workspaces one call searches when it names none (ADR-051 §4). */
const MAX_DEFAULT_WORKSPACES = 8

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
    workspaces: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(MAX_DEFAULT_WORKSPACES)
      .optional()
      .describe(
        "Workspace slugs from list_workspaces. Omit it to search all Workspaces of the org (at most 8; Workspaces that are not ready are skipped).",
      ),
    kinds: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe("Only units of these kinds."),
    pathPrefix: z
      .string()
      .max(1_024)
      .optional()
      .describe("Only units whose path starts with this prefix."),
    sources: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe("Only units from these sources."),
    updatedAfter: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("Only units updated after this time (ISO 8601)."),
    validAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("Only units valid at this time (ISO 8601)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Hits in one page. Default 10."),
    cursor: z
      .string()
      .max(2_048)
      .optional()
      .describe("The cursor of the last result, for the next page."),
  },
  outputSchema: z.object({
    hits: z.array(hitSchema),
    skipped: z.array(skippedSchema),
    cursor: z.string().optional(),
    truncated: z.boolean().optional(),
  }),
  async run(input, { org }) {
    const named = input.workspaces !== undefined
    const slugs = [
      ...new Set(input.workspaces ?? (await listOrgWorkspaceSlugs(org))),
    ].sort()
    if (!named && slugs.length > MAX_DEFAULT_WORKSPACES) {
      throw new McpToolError(
        "invalid_argument",
        `The org has ${slugs.length} Workspaces; a call searches at most ${MAX_DEFAULT_WORKSPACES}. Name them in workspaces.`,
      )
    }
    const resolved = await Promise.all(
      slugs.map((slug) => resolveCallWorkspace(org, slug)),
    )
    const skipped: Skipped[] = []
    const workspaces = resolved.flatMap((workspace) => {
      if (workspace.served) return [{ ...workspace, served: workspace.served }]
      if (named) requireServed(workspace)
      skipped.push({ workspace: workspace.slug, reason: "not_ready" })
      return []
    })
    const hits =
      workspaces.length === 0
        ? []
        : await searchKnowledge({
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
        workspaces.map((workspace) => [workspace.id, workspace.served.sha]),
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
        served: { ...workspace.served, sha: hit.projectionSha },
      }
    })
    const { page, nextOffset, truncated } = fitPage(items, {
      offset,
      limit: input.limit,
      maxTokens: 4_000,
      result: (fitted) => ({ hits: fitted, skipped }),
    })
    return {
      hits: page,
      skipped,
      ...(nextOffset === null
        ? {}
        : { cursor: encodeCursor({ ...binding, offset: nextOffset }) }),
      ...(truncated ? { truncated: true } : {}),
    }
  },
})
