import { z } from "zod"

import type { KnowledgeHit } from "../../domain/workspaces/knowledge-search.js"
import { selectKnowledgeReader } from "../../knowledge-reader/knowledge-reader.js"
import { knowledgeViewKey } from "../../models/knowledge-state.js"
import { fitPage, truncateText } from "../framework/budget.js"
import {
  listOrgWorkspaceSlugs,
  requireServed,
  resolveCallWorkspace,
} from "../framework/call-workspace.js"
import { decodeCursor, encodeCursor } from "../framework/cursor.js"
import {
  branchArgument,
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
  claims: z
    .string()
    .optional()
    .describe("The claims of the unit: predicate and target, at most five."),
  served: servedSchema,
})

/**
 * The claims of a unit on one line: at most five `PREDICATE target` pairs,
 * then the number of the others. Undefined when the unit has no claim.
 */
function claimSummary(
  claims: readonly { predicate: string | null; to: string }[],
): string | undefined {
  if (claims.length === 0) return undefined
  const shown = claims
    .slice(0, 5)
    .map(({ predicate, to }) => (predicate ? `${predicate} ${to}` : to))
  const more = claims.length - shown.length
  return truncateText(
    [...shown, ...(more > 0 ? [`+${more} more`] : [])].join("; "),
    300,
  )
}

/** The hits of a page when the call gives no `limit`. */
export const SEARCH_PAGE_LIMIT = 8

/**
 * One page of the search hits from `offset`, as the tool gives it without
 * the cursor: at most `limit` hits that fit the token budget. The knowledge
 * eval measures the first page with this function too.
 */
export function searchKnowledgePage(input: {
  hits: readonly KnowledgeHit[]
  workspaces: readonly {
    id: string
    slug: string
    served: z.infer<typeof servedSchema>
  }[]
  skipped: Skipped[]
  partialReason?: string
  offset: number
  limit: number
}) {
  const items = input.hits.map((hit) => {
    const workspace = input.workspaces.find((w) => w.id === hit.workspaceId)
    if (!workspace) throw new Error("Search returned an unknown Workspace")
    const claims = claimSummary(hit.claims)
    return {
      workspace: workspace.slug,
      ref: hit.path,
      title: hit.title,
      kind: hit.kind,
      source: hit.source,
      updatedAt: hit.updatedAt.toISOString(),
      snippet: truncateText(hit.text, 600),
      startLine: hit.startLine,
      endLine: hit.endLine,
      score: hit.score,
      ...(claims ? { claims } : {}),
      served: { ...workspace.served, sha: hit.projectionSha },
    }
  })
  const { skipped } = input
  const partial = input.partialReason
    ? { partial: true, partialReason: input.partialReason }
    : {}
  const { page, nextOffset, truncated } = fitPage(items, {
    offset: input.offset,
    limit: input.limit,
    maxTokens: 4_000,
    result: (fitted) => ({ hits: fitted, skipped, ...partial }),
  })
  return { hits: page, skipped, ...partial, nextOffset, truncated }
}

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
    branch: branchArgument,
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
      .max(20)
      .default(SEARCH_PAGE_LIMIT)
      .describe("Hits in one page. Default 8, at most 20."),
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
    partial: z
      .boolean()
      .optional()
      .describe("True when the hits are in the search order only."),
    partialReason: z.string().optional(),
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
    const servedWorkspaces = resolved.flatMap((workspace) => {
      if (workspace.served) return [{ ...workspace, served: workspace.served }]
      if (named) requireServed(workspace)
      skipped.push({ workspace: workspace.slug, reason: "not_ready" })
      return []
    })
    const { reader, planeHeads } = await selectKnowledgeReader(
      org.id,
      servedWorkspaces.map((workspace) => workspace.id),
      input.branch,
    )
    // The plane serves the SHA of its last full run of the branch.
    const workspaces = servedWorkspaces.map((workspace) => {
      const head = planeHeads.get(workspace.id)
      return head
        ? {
            ...workspace,
            served: {
              branch: input.branch ?? workspace.served.branch,
              sha: head.sha,
            },
          }
        : workspace
    })
    const { hits, partialReason } =
      workspaces.length === 0
        ? { hits: [], partialReason: undefined }
        : await reader.search({
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
      stack: reader.stack,
      scope: JSON.stringify(["search_knowledge", parameters]),
      sha: JSON.stringify([
        workspaces.map((workspace) => {
          const head = planeHeads.get(workspace.id)
          return [
            workspace.id,
            head ? knowledgeViewKey(head) : workspace.served.sha,
          ]
        }),
        [
          ...new Set(
            hits.map((hit) => `${hit.workspaceId}:${hit.projectionSha}`),
          ),
        ].sort(),
      ]),
    }
    const offset = cursor ? decodeCursor(cursor, binding) : 0
    const { nextOffset, truncated, ...page } = searchKnowledgePage({
      hits,
      workspaces,
      skipped,
      partialReason,
      offset,
      limit: input.limit,
    })
    return {
      ...page,
      ...(nextOffset === null
        ? {}
        : { cursor: encodeCursor({ ...binding, offset: nextOffset }) }),
      ...(truncated ? { truncated: true } : {}),
    }
  },
})
