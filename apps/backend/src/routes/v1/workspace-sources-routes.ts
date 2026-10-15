import { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  type SourceChange,
  SourceChangeError,
} from "../../domain/workspace-sources/edit.js"
import { requestConnectionSourcesSync } from "../../domain/workspace-sources/enqueue.js"
import {
  addWorkspaceSources,
  changeWorkspaceSource,
  listConnectionUsage,
  listWorkspaceSources,
} from "../../domain/workspace-sources/service.js"
import { getWorkspaceBySlug } from "../../models/workspaces.js"
import {
  batchCreateWorkspaceSourcesRoute,
  createWorkspaceSourceRoute,
  deleteWorkspaceSourceRoute,
  listConnectionWorkspacesRoute,
  listWorkspaceSourcesRoute,
  renameWorkspaceSourceRoute,
  syncConnectionSourcesRoute,
  updateWorkspaceSourceRoute,
} from "./workspace-sources-contract.js"

async function applyChange(
  workspaceSlug: string,
  change: SourceChange,
  delivery: "pull_request" | "commit",
) {
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) return { status: 404 as const, error: "Not found" }
  try {
    const result = await changeWorkspaceSource({ workspace, change, delivery })
    return { status: 200 as const, result }
  } catch (error) {
    if (error instanceof SourceChangeError)
      return { status: error.status, error: error.message }
    throw error
  }
}

async function applyBatch(
  workspaceSlug: string,
  changes: Array<Extract<SourceChange, { action: "add" }>>,
  delivery: "pull_request" | "commit",
) {
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) return { status: 404 as const, error: "Not found" }
  try {
    const result = await addWorkspaceSources({ workspace, changes, delivery })
    return { status: 200 as const, result }
  } catch (error) {
    if (error instanceof SourceChangeError)
      return { status: error.status, error: error.message }
    throw error
  }
}

export const workspaceSourcesRoutes = new OpenAPIHono<AppEnv>()
  .openapi(listWorkspaceSourcesRoute, async (c) => {
    if (!c.get("user") || !c.get("session"))
      return c.json({ error: "Unauthorized" }, 401)
    const workspace = await getWorkspaceBySlug(
      c.req.valid("param").workspaceSlug,
    )
    if (!workspace) return c.json({ error: "Not found" }, 404)
    return c.json(await listWorkspaceSources(workspace), 200)
  })
  .openapi(createWorkspaceSourceRoute, async (c) => {
    if (!c.get("user") || !c.get("session"))
      return c.json({ error: "Unauthorized" }, 401)
    const body = c.req.valid("json")
    const out = await applyChange(
      c.req.valid("param").workspaceSlug,
      { action: "add", path: body.path, ...body.source },
      body.delivery,
    )
    if (out.status === 200) return c.json(out.result, 200)
    return c.json({ error: out.error }, out.status)
  })
  .openapi(batchCreateWorkspaceSourcesRoute, async (c) => {
    if (!c.get("user") || !c.get("session"))
      return c.json({ error: "Unauthorized" }, 401)
    const body = c.req.valid("json")
    const out = await applyBatch(
      c.req.valid("param").workspaceSlug,
      body.sources.map((item) => ({
        action: "add" as const,
        path: item.path,
        ...item.source,
      })),
      body.delivery,
    )
    if (out.status === 200) return c.json(out.result, 200)
    return c.json({ error: out.error }, out.status)
  })
  .openapi(updateWorkspaceSourceRoute, async (c) => {
    if (!c.get("user") || !c.get("session"))
      return c.json({ error: "Unauthorized" }, 401)
    const body = c.req.valid("json")
    const out = await applyChange(
      c.req.valid("param").workspaceSlug,
      { action: "edit", path: body.path, ...body.source },
      body.delivery,
    )
    if (out.status === 200) return c.json(out.result, 200)
    return c.json({ error: out.error }, out.status)
  })
  .openapi(renameWorkspaceSourceRoute, async (c) => {
    if (!c.get("user") || !c.get("session"))
      return c.json({ error: "Unauthorized" }, 401)
    const body = c.req.valid("json")
    const out = await applyChange(
      c.req.valid("param").workspaceSlug,
      { action: "rename", path: body.path, newPath: body.newPath },
      body.delivery,
    )
    if (out.status === 200) return c.json(out.result, 200)
    return c.json({ error: out.error }, out.status)
  })
  .openapi(deleteWorkspaceSourceRoute, async (c) => {
    if (!c.get("user") || !c.get("session"))
      return c.json({ error: "Unauthorized" }, 401)
    const { path, delivery } = c.req.valid("query")
    const out = await applyChange(
      c.req.valid("param").workspaceSlug,
      { action: "remove", path },
      delivery,
    )
    if (out.status === 200) return c.json(out.result, 200)
    return c.json({ error: out.error }, out.status)
  })

export const connectionUsageRoutes = new OpenAPIHono<AppEnv>().openapi(
  listConnectionWorkspacesRoute,
  async (c) => {
    if (!c.get("user") || !c.get("session"))
      return c.json({ error: "Unauthorized" }, 401)
    const usage = await listConnectionUsage(c.req.valid("param").connectionId)
    if (!usage) return c.json({ error: "Not found" }, 404)
    return c.json(usage, 200)
  },
)

/** "Sync now" on a connector. Mount it behind the org admin check. */
export const connectionSyncRoutes = new OpenAPIHono<AppEnv>().openapi(
  syncConnectionSourcesRoute,
  async (c) => {
    const orgId = c.get("orgId")
    if (!c.get("user") || !c.get("session") || !orgId)
      return c.json({ error: "Unauthorized" }, 401)
    const queued = await requestConnectionSourcesSync({
      orgId,
      connectionId: c.req.valid("param").connectionId,
      now: new Date(),
    })
    if (!queued) return c.json({ error: "Not found" }, 404)
    return c.json({ accepted: true as const }, 202)
  },
)
