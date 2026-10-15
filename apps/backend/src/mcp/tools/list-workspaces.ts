import { and, asc, count, eq } from "drizzle-orm"
import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import {
  workspaceKnowledgeUnits,
  workspaces,
} from "../../db/schema/workspaces.js"
import { readWorkspaceCheckoutFile } from "../../domain/workspaces/checkout-read.js"
import { explorerBlobFromGitFile } from "../../domain/workspaces/git-explorer.js"
import { parseSimpleFrontMatter } from "../../domain/workspaces/layout.js"
import { publishedProjection } from "../../domain/workspaces/revision.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import {
  getWorkspaceSearchProjection,
  projectionFromWorkspace,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import { fitPage, truncateText } from "../framework/budget.js"
import {
  listOrgRepositoryLinks,
  loadWorkspaceHandles,
  resolveCallWorkspace,
  workspaceLinkHandles,
} from "../framework/call-workspace.js"
import { decodeCursor, encodeCursor } from "../framework/cursor.js"
import { RepositoryHandles } from "../framework/repository-handles.js"
import {
  type Skipped,
  servedSchema,
  skippedSchema,
  workspaceArgument,
} from "../framework/schemas.js"
import { orgRequired } from "../framework/tool-errors.js"
import { listToolOrgs } from "../framework/tool-org.js"
import { defineMcpReadTool } from "../framework/tool-registry.js"

/** Workspaces in one page of list mode (ADR-051 §5). */
const PAGE_SIZE = 100

/** Repositories in one page of detail mode (ADR-051 §5). */
const REPOSITORY_PAGE_SIZE = 50

/** Sources and unit kinds that the detail header lists; the rest is a count. */
const MAX_HEADER_ITEMS = 10

/**
 * The first paragraph of a Workspace `AGENTS.md`, on one line, at most 300
 * characters. Headings, comments, tables and code fences are not a
 * description.
 */
export function agentsDescription(markdown: string): string | null {
  const { body } = parseSimpleFrontMatter(markdown.slice(0, 16 * 1024))
  const withoutComments = body.replace(/<!--[\s\S]*?(-->|$)/g, "")
  for (const block of withoutComments.split(/\r?\n\s*\r?\n/)) {
    const text = block
      .split(/\r?\n/)
      .filter((line) => !/^\s*(#|\||```|>)/.test(line))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return truncateText(text, 300)
  }
  return null
}

/**
 * The description from the `AGENTS.md` of the published Workspace checkout.
 * Null when the checkout is not indexed or codesearch cannot read it: the
 * description is optional, so the call does not fail.
 */
async function readWorkspaceDescription(
  workspaceId: string,
): Promise<string | null> {
  try {
    const { projection, repositories } =
      await getWorkspaceSearchProjection(workspaceId)
    const active = publishedProjection(projection)
    const published =
      active?.kind === "active" ? active.stores.index.published : null
    const repository = published
      ? repositories.find(
          (repo) =>
            repo.sha === published.sha &&
            normalizeWorkspaceRepositoryUrl(repo.gitUrl) ===
              normalizeWorkspaceRepositoryUrl(published.remote.url),
        )
      : undefined
    if (!published || !repository) return null
    const file = await readWorkspaceCheckoutFile({
      workspaceId,
      repositoryId: repository.id,
      sha: published.sha,
      path: "AGENTS.md",
    })
    const blob = explorerBlobFromGitFile(file)
    return blob?.body ? agentsDescription(blob.body) : null
  } catch {
    log.warn({ step: "mcp.list_workspaces.description_failed", workspaceId })
    return null
  }
}

type ListedWorkspace = {
  slug: string
  title: string
  repositories: number
  ready: boolean
}

/** One row of the flat list that list mode pages: a Workspace, or an org with none. */
type ListItem = {
  org: string
  workspace: ListedWorkspace | null
  skipped: Skipped | null
}

/** Group a page of items by org, in order. */
function groupByOrg(page: readonly ListItem[]) {
  const orgs: Array<{
    org: string
    workspaces: ListedWorkspace[]
    skipped: Skipped[]
  }> = []
  for (const item of page) {
    let entry = orgs.at(-1)
    if (entry?.org !== item.org) {
      entry = { org: item.org, workspaces: [], skipped: [] }
      orgs.push(entry)
    }
    if (item.workspace) entry.workspaces.push(item.workspace)
    if (item.skipped) entry.skipped.push(item.skipped)
  }
  return orgs
}

export const listWorkspaces = defineMcpReadTool({
  name: "list_workspaces",
  title: "List Workspaces",
  description:
    "List the Workspaces this connection can read. Omit org to list all allowed orgs. Pass org and workspace for the description, repositories, sources, unit counts, and readiness of one Workspace. Send independent calls in parallel.",
  org: "optional",
  alwaysLoad: true,
  inputShape: {
    workspace: workspaceArgument
      .optional()
      .describe(
        "Workspace slug. Omit it to list Workspaces; name one for its description, repositories, sources, unit counts, and readiness.",
      ),
    cursor: z
      .string()
      .max(2_048)
      .optional()
      .describe("The cursor of the last list result, for the next page."),
  },
  outputSchema: z.object({
    orgs: z
      .array(
        z.object({
          org: z.string(),
          workspaces: z.array(
            z.object({
              slug: z.string(),
              title: z.string(),
              repositories: z.number(),
              ready: z.boolean(),
            }),
          ),
          skipped: z.array(skippedSchema),
        }),
      )
      .optional(),
    cursor: z.string().optional(),
    truncated: z.boolean().optional(),
    org: z.string().optional(),
    workspace: z.string().optional(),
    title: z.string().optional(),
    description: z
      .string()
      .optional()
      .describe("The first paragraph of the Workspace AGENTS.md."),
    served: servedSchema.nullable().optional(),
    readiness: z
      .object({
        knowledge: z.string(),
        embeddings: z.string(),
        graph: z.string(),
        index: z.string(),
      })
      .optional(),
    repositories: z.array(z.string()).optional(),
    units: z
      .record(z.string(), z.number().int())
      .optional()
      .describe("Knowledge units of the served revision, for each kind."),
    unitKindsNotShown: z
      .number()
      .int()
      .optional()
      .describe("Kinds of units that units leaves out."),
    sourcesNotShown: z
      .number()
      .int()
      .optional()
      .describe("Sources that sources leaves out."),
    sources: z
      .array(
        z.object({
          key: z.string(),
          provider: z.string().nullable(),
          status: z.string(),
        }),
      )
      .optional(),
    skipped: z.array(skippedSchema).optional(),
  }),
  async run({ workspace, cursor }, { org }) {
    if (workspace) {
      if (!org) throw orgRequired()
      const resolved = await resolveCallWorkspace(org, workspace)
      const { linked, invalid } = await loadWorkspaceHandles(org, resolved.id)
      const handles = [...linked].sort()
      const servedSha = resolved.served?.sha ?? null
      const [{ row, sources, kinds }, description] = await Promise.all([
        withOrgDbContext(org.id, async (db) => {
          const [row] = await db
            .select()
            .from(workspaces)
            .where(
              and(eq(workspaces.orgId, org.id), eq(workspaces.id, resolved.id)),
            )
          const sources = await db
            .select({
              key: workspaceSources.sourceKey,
              provider: workspaceSources.provider,
              status: workspaceSources.status,
            })
            .from(workspaceSources)
            .where(
              and(
                eq(workspaceSources.orgId, org.id),
                eq(workspaceSources.workspaceId, resolved.id),
              ),
            )
            .orderBy(asc(workspaceSources.sourceKey))
          const kinds = servedSha
            ? await db
                .select({
                  kind: workspaceKnowledgeUnits.kind,
                  units: count(),
                })
                .from(workspaceKnowledgeUnits)
                .where(
                  and(
                    eq(workspaceKnowledgeUnits.orgId, org.id),
                    eq(workspaceKnowledgeUnits.workspaceId, resolved.id),
                    eq(workspaceKnowledgeUnits.projectionSha, servedSha),
                  ),
                )
                .groupBy(workspaceKnowledgeUnits.kind)
                .orderBy(asc(workspaceKnowledgeUnits.kind))
            : []
          return { row, sources, kinds }
        }),
        cursor ? Promise.resolve(null) : readWorkspaceDescription(resolved.id),
      ])
      const projection = row
        ? publishedProjection(projectionFromWorkspace(row))
        : null
      const units: Record<string, number> = {}
      for (const { kind, units: total } of kinds) {
        const key = kind ?? "unit"
        units[key] = (units[key] ?? 0) + total
      }
      const storeKind = (store: "embeddings" | "graph" | "index") =>
        projection?.kind === "active"
          ? projection.stores[store].kind
          : projection
            ? "unknown"
            : "pending"
      // The first page holds the whole detail. A next page holds only the
      // repositories after the cursor.
      const header = cursor
        ? { org: org.slug, workspace: resolved.slug }
        : {
            org: org.slug,
            workspace: resolved.slug,
            title: truncateText(resolved.title, 60),
            ...(description ? { description } : {}),
            served: resolved.served,
            readiness: {
              knowledge: projection ? "ready" : "pending",
              embeddings: storeKind("embeddings"),
              graph: storeKind("graph"),
              index: storeKind("index"),
            },
            units: Object.fromEntries(
              Object.entries(units).slice(0, MAX_HEADER_ITEMS),
            ),
            ...(Object.keys(units).length > MAX_HEADER_ITEMS
              ? {
                  unitKindsNotShown:
                    Object.keys(units).length - MAX_HEADER_ITEMS,
                }
              : {}),
            sources: sources.slice(0, MAX_HEADER_ITEMS),
            ...(sources.length > MAX_HEADER_ITEMS
              ? { sourcesNotShown: sources.length - MAX_HEADER_ITEMS }
              : {}),
            skipped: invalid
              ? [{ workspace: resolved.slug, reason: "invalid_url" as const }]
              : [],
          }
      const binding = {
        orgId: org.id,
        workspaceId: resolved.id,
        scope: JSON.stringify(["list_workspaces", "repositories"]),
        sha: JSON.stringify([servedSha, handles]),
      }
      const page = fitPage(handles, {
        offset: cursor ? decodeCursor(cursor, binding) : 0,
        limit: REPOSITORY_PAGE_SIZE,
        maxTokens: 600,
        // A handle is never cut: a cut handle names another repository.
        shrink: () => null,
        result: (fitted) => ({
          ...header,
          repositories: fitted,
          truncated: true,
        }),
      })
      return {
        ...header,
        repositories: page.page,
        ...(page.truncated ? { truncated: true } : {}),
        ...(page.nextOffset === null
          ? {}
          : { cursor: encodeCursor({ ...binding, offset: page.nextOffset }) }),
      }
    }
    const items: ListItem[] = []
    for (const allowed of org ? [org] : await listToolOrgs()) {
      const [rows, links] = await Promise.all([
        withOrgDbContext(allowed.id, (db) =>
          db
            .select()
            .from(workspaces)
            .where(eq(workspaces.orgId, allowed.id))
            .orderBy(asc(workspaces.slug)),
        ),
        listOrgRepositoryLinks(allowed),
      ])
      const handles = RepositoryHandles.from(links.map((link) => link.gitUrl))
      if (rows.length === 0) {
        items.push({ org: allowed.slug, workspace: null, skipped: null })
      }
      for (const row of rows) {
        const projection = publishedProjection(projectionFromWorkspace(row))
        const { linked, invalid } = workspaceLinkHandles(
          handles,
          links.filter((link) => link.workspaceId === row.id),
        )
        items.push({
          org: allowed.slug,
          workspace: {
            slug: row.slug,
            title: truncateText(
              row.displayName.replace(/\s+/g, " ").trim(),
              60,
            ),
            repositories: linked.size,
            ready:
              projection?.kind === "active" &&
              Object.values(projection.stores).every(
                (store) => store.kind === "ready",
              ),
          },
          skipped: invalid
            ? { workspace: row.slug, reason: "invalid_url" }
            : null,
        })
      }
    }
    const binding = {
      orgId: org?.id ?? "*",
      workspaceId: null,
      scope: JSON.stringify(["list_workspaces", org?.slug ?? null]),
      sha: JSON.stringify(
        items.map((item) => [item.org, item.workspace?.slug ?? null]),
      ),
    }
    const offset = cursor ? decodeCursor(cursor, binding) : 0
    const page = fitPage(items, {
      offset,
      limit: PAGE_SIZE,
      maxTokens: 4_000,
      result: (fitted) => ({ orgs: groupByOrg(fitted), truncated: true }),
    })
    return {
      orgs: groupByOrg(page.page),
      ...(page.truncated ? { truncated: true } : {}),
      ...(page.nextOffset === null
        ? {}
        : { cursor: encodeCursor({ ...binding, offset: page.nextOffset }) }),
    }
  },
})
