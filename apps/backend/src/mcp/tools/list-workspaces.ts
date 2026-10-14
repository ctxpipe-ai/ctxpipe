import { and, asc, eq } from "drizzle-orm"
import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { publishedProjection } from "../../domain/workspaces/revision.js"
import { projectionFromWorkspace } from "../../models/workspaces.js"
import { truncateText } from "../framework/budget.js"
import {
  listOrgRepositoryUrls,
  loadOrgRepositoryHandles,
  resolveCallWorkspace,
} from "../framework/call-workspace.js"
import { RepositoryHandles } from "../framework/repository-handles.js"
import { orgRequired } from "../framework/tool-errors.js"
import { listToolOrgs } from "../framework/tool-org.js"
import { defineMcpReadTool } from "../framework/tool-registry.js"

export const listWorkspaces = defineMcpReadTool({
  name: "list_workspaces",
  title: "List Workspaces",
  description:
    "List the Workspaces this connection can read. Omit org to list all allowed orgs. Send independent calls in parallel.",
  org: "optional",
  alwaysLoad: true,
  inputShape: { workspace: z.string().min(1).max(64).optional() },
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
        }),
      )
      .optional(),
    org: z.string().optional(),
    workspace: z.string().optional(),
    title: z.string().optional(),
    served: z
      .object({ branch: z.string(), sha: z.string() })
      .nullable()
      .optional(),
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
    excluded: z.array(z.string()).optional(),
  }),
  async run({ workspace }, { org }) {
    if (workspace) {
      if (!org) throw orgRequired()
      const resolved = await resolveCallWorkspace(org, workspace)
      const handles = await loadOrgRepositoryHandles(org)
      const repositories = [
        ...new Set(
          (await listOrgRepositoryUrls(org, resolved.id)).map(
            (url) => handles.resolve(url).handle,
          ),
        ),
      ].sort()
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
        excluded: [],
      }
    }
    const orgs = org ? [org] : await listToolOrgs()
    const result = []
    for (const allowed of orgs) {
      const rows = await withOrgDbContext(allowed.id, (db) =>
        db
          .select()
          .from(workspaces)
          .where(eq(workspaces.orgId, allowed.id))
          .orderBy(asc(workspaces.slug)),
      )
      const summaries = []
      for (const row of rows) {
        const projection = publishedProjection(projectionFromWorkspace(row))
        summaries.push({
          slug: row.slug,
          title: truncateText(row.displayName.replace(/\s+/g, " ").trim(), 32),
          repositories: RepositoryHandles.from(
            await listOrgRepositoryUrls(allowed, row.id),
          ).list().length,
          ready:
            projection?.kind === "active" &&
            Object.values(projection.stores).every(
              (store) => store.kind === "ready",
            ),
        })
      }
      result.push({ org: allowed.slug, workspaces: summaries })
    }
    return { orgs: result }
  },
})
