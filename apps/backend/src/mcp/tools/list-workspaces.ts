import { and, asc, eq } from "drizzle-orm"
import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { publishedProjection } from "../../domain/workspaces/revision.js"
import { projectionFromWorkspace } from "../../models/workspaces.js"
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
    "List the Workspaces this connection can read. Omit org to list all allowed orgs. Send independent calls in parallel.",
  org: "optional",
  alwaysLoad: true,
  inputShape: {
    workspace: workspaceArgument
      .optional()
      .describe(
        "Workspace slug. Omit it to list Workspaces; name one for its repositories, sources, and readiness.",
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
      const repositories = [...linked].sort()
      const { row, sources } = await withOrgDbContext(org.id, async (db) => {
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
        return { row, sources }
      })
      const projection = row
        ? publishedProjection(projectionFromWorkspace(row))
        : null
      return {
        org: org.slug,
        workspace: resolved.slug,
        title: resolved.title,
        served: resolved.served,
        readiness: {
          knowledge: projection ? "ready" : "pending",
          embeddings:
            projection?.kind === "active"
              ? projection.stores.embeddings.kind
              : projection
                ? "unknown"
                : "pending",
          graph:
            projection?.kind === "active"
              ? projection.stores.graph.kind
              : projection
                ? "unknown"
                : "pending",
          index:
            projection?.kind === "active"
              ? projection.stores.index.kind
              : projection
                ? "unknown"
                : "pending",
        },
        repositories,
        sources,
        skipped: invalid
          ? [{ workspace: resolved.slug, reason: "invalid_url" as const }]
          : [],
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
              32,
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
