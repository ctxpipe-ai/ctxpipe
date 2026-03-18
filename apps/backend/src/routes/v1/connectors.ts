import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  createConnectorSpaces,
  listConnectorSpaces,
  replaceConnectorSpaces,
} from "../../models/connector-spaces.js"
import {
  createSyncLog,
  getLatestSyncLog,
  listSyncLogs,
} from "../../models/connector-sync-logs.js"
import { syncOrchestrator } from "../../services/confluence/index.js"
import { ConfluenceClient } from "../../services/confluence/client.js"
import {
  createConnector,
  deleteConnector,
  disableConnector,
  enableConnector,
  getConnector,
  listConnectors,
  updateConnector,
} from "../../models/connectors.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ErrorResponse")

const ConnectorConfigSchema = z
  .object({
    // syncMode and schedule are system-controlled; kept for DB compatibility only
    syncMode: z.enum(["pr", "auto"]).optional().default("auto"),
    schedule: z.enum(["hourly", "daily", "manual"]).optional().default("manual"),
    confluenceBaseUrl: z.string().url().optional(),
    confluenceEmail: z.string().email().optional(),
    confluenceApiToken: z.string().optional(),
    githubToken: z.string().optional(),
  })
  .openapi("ConnectorConfig")

const ConnectorSchema = z
  .object({
    id: z.string(),
    orgId: z.string(),
    type: z.string(),
    config: ConnectorConfigSchema,
    enabled: z.boolean(),
    githubRepoId: z.string().nullable(),
    githubRepoName: z.string().nullable(),
    githubBranch: z.string().nullable(),
    lastPrNumber: z.number().nullable(),
    lastSyncAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Connector")

const CreateConnectorRequestSchema = z
  .object({
    type: z.string(),
    githubRepoName: z.string().optional(),
    githubBranch: z.string().optional(),
    config: ConnectorConfigSchema,
    spaces: z
      .array(
        z.object({
          spaceKey: z.string(),
          spaceName: z.string().optional(),
        }),
      )
      .optional(),
  })
  .openapi("CreateConnectorRequest")

const UpdateConnectorRequestSchema = z
  .object({
    config: ConnectorConfigSchema.optional(),
    enabled: z.boolean().optional(),
    githubRepoName: z.string().optional(),
    githubBranch: z.string().optional(),
    spaces: z
      .array(
        z.object({
          spaceKey: z.string(),
          spaceName: z.string().optional(),
        }),
      )
      .optional(),
  })
  .openapi("UpdateConnectorRequest")

const ConnectorSpaceSchema = z
  .object({
    id: z.string(),
    connectorId: z.string(),
    spaceKey: z.string(),
    spaceName: z.string().nullable(),
    selectedPageIds: z.array(z.string()).nullable(),
    lastSyncedPageId: z.string().nullable(),
    lastSyncedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("ConnectorSpace")

const ConfluenceSpaceInfoSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    type: z.string(),
  })
  .openapi("ConfluenceSpaceInfo")

const ConfluencePageSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    spaceId: z.string(),
    parentId: z.string().optional(),
  })
  .openapi("ConfluencePageSummary")

const ScopedSpaceSchema = z.object({
  spaceKey: z.string(),
  spaceName: z.string().optional(),
  selectedPageIds: z.array(z.string()).nullable().optional(),
})

const SaveScopeRequestSchema = z
  .object({
    spaces: z.array(ScopedSpaceSchema),
  })
  .openapi("SaveScopeRequest")

const ConfigSyncResultSchema = z
  .object({
    noChange: z.boolean().optional(),
    prNumber: z.number().nullable(),
    prUrl: z.string().nullable(),
  })
  .openapi("ConfigSyncResult")

const SyncLogSchema = z
  .object({
    id: z.string(),
    connectorId: z.string(),
    status: z.string(),
    prNumber: z.number().nullable(),
    prUrl: z.string().nullable(),
    pagesAdded: z.number(),
    pagesUpdated: z.number(),
    pagesDeleted: z.number(),
    errorMessage: z.string().nullable(),
    startedAt: z.string(),
    completedAt: z.string().nullable(),
  })
  .openapi("SyncLog")

const ListConnectorsResponseSchema = z
  .object({
    items: z.array(ConnectorSchema),
  })
  .openapi("ListConnectorsResponse")

const ConnectorWithSpacesSchema = ConnectorSchema.extend({
  spaces: z.array(ConnectorSpaceSchema),
  lastSyncLog: SyncLogSchema.nullable(),
})

const ConnectorDetailResponseSchema = ConnectorWithSpacesSchema.openapi(
  "ConnectorDetailResponse",
)

const ListSyncLogsResponseSchema = z
  .object({
    items: z.array(SyncLogSchema),
  })
  .openapi("ListSyncLogsResponse")

export const listConnectorsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["connectors"],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ListConnectorsResponseSchema,
        },
      },
      description: "List connectors for the current org",
    },
    401: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Unauthorized",
    },
  },
})

export const getConnectorRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["connectors"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ConnectorDetailResponseSchema,
        },
      },
      description: "Connector details with spaces and sync logs",
    },
    401: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Not found",
    },
  },
})

export const createConnectorRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["connectors"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreateConnectorRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: ConnectorSchema,
        },
      },
      description: "Connector created",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Bad request",
    },
    401: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Unauthorized",
    },
    409: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Connector of this type already exists",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
})

export const updateConnectorRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["connectors"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: UpdateConnectorRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ConnectorSchema,
        },
      },
      description: "Connector updated",
    },
    401: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Not found",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
})

export const deleteConnectorRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["connectors"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    204: {
      description: "Connector disabled",
    },
    401: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Not found",
    },
  },
})

export const triggerSyncRoute = createRoute({
  method: "post",
  path: "/{id}/sync",
  tags: ["connectors"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: SyncLogSchema,
        },
      },
      description: "Sync started",
    },
    401: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Not found",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
})

export const listAvailableSpacesRoute = createRoute({
  method: "get",
  path: "/{id}/available-spaces",
  tags: ["connectors"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ items: z.array(ConfluenceSpaceInfoSchema) }),
        },
      },
      description: "List available Confluence spaces",
    },
    400: { content: { "application/json": { schema: ErrorResponseSchema } }, description: "Bad request" },
    401: { content: { "application/json": { schema: ErrorResponseSchema } }, description: "Unauthorized" },
    404: { content: { "application/json": { schema: ErrorResponseSchema } }, description: "Not found" },
  },
})

export const listSpacePagesRoute = createRoute({
  method: "get",
  path: "/{id}/available-spaces/{spaceKey}/pages",
  tags: ["connectors"],
  request: {
    params: z.object({ id: z.string(), spaceKey: z.string() }),
    query: z.object({ parentId: z.string().optional() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ items: z.array(ConfluencePageSummarySchema) }),
        },
      },
      description: "List pages in a Confluence space",
    },
    400: { content: { "application/json": { schema: ErrorResponseSchema } }, description: "Bad request" },
    401: { content: { "application/json": { schema: ErrorResponseSchema } }, description: "Unauthorized" },
    404: { content: { "application/json": { schema: ErrorResponseSchema } }, description: "Not found" },
  },
})

export const searchSpacePagesRoute = createRoute({
  method: "get",
  path: "/{id}/available-spaces/{spaceKey}/search",
  tags: ["connectors"],
  request: {
    params: z.object({ id: z.string(), spaceKey: z.string() }),
    query: z.object({ q: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ items: z.array(ConfluencePageSummarySchema) }),
        },
      },
      description: "Search pages in a Confluence space by title",
    },
    400: { content: { "application/json": { schema: ErrorResponseSchema } }, description: "Bad request" },
    401: { content: { "application/json": { schema: ErrorResponseSchema } }, description: "Unauthorized" },
    404: { content: { "application/json": { schema: ErrorResponseSchema } }, description: "Not found" },
    500: { content: { "application/json": { schema: ErrorResponseSchema } }, description: "Internal server error" },
  },
})

export const saveScopeRoute = createRoute({
  method: "post",
  path: "/{id}/scope",
  tags: ["connectors"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: SaveScopeRequestSchema } },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: ConfigSyncResultSchema },
      },
      description: "Scope saved and config PR opened (if changed)",
    },
    400: { content: { "application/json": { schema: ErrorResponseSchema } }, description: "Bad request" },
    401: { content: { "application/json": { schema: ErrorResponseSchema } }, description: "Unauthorized" },
    404: { content: { "application/json": { schema: ErrorResponseSchema } }, description: "Not found" },
    500: { content: { "application/json": { schema: ErrorResponseSchema } }, description: "Internal server error" },
  },
})

export const listSyncLogsRoute = createRoute({
  method: "get",
  path: "/{id}/logs",
  tags: ["connectors"],
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      limit: z
        .string()
        .transform((v) => parseInt(v, 10))
        .optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ListSyncLogsResponseSchema,
        },
      },
      description: "List sync logs",
    },
    401: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Not found",
    },
  },
})

type ConnectorResponse = z.infer<typeof ConnectorSchema>
type ConnectorSpaceResponse = z.infer<typeof ConnectorSpaceSchema>
type SyncLogResponse = z.infer<typeof SyncLogSchema>

const connectorToResponse = (c: {
  id: string
  orgId: string
  type: string
  config: { syncMode: string; schedule: string }
  enabled: boolean
  githubRepoId: string | null
  githubRepoName: string | null
  githubBranch: string | null
  lastPrNumber: number | null
  lastSyncAt: Date | null
  createdAt: Date
  updatedAt: Date
}): ConnectorResponse => ({
  id: c.id,
  orgId: c.orgId,
  type: c.type,
  config: c.config as ConnectorResponse["config"],
  enabled: c.enabled,
  githubRepoId: c.githubRepoId,
  githubRepoName: c.githubRepoName,
  githubBranch: c.githubBranch,
  lastPrNumber: c.lastPrNumber,
  lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
})

const spaceToResponse = (s: {
  id: string
  connectorId: string
  spaceKey: string
  spaceName: string | null
  selectedPageIds?: string[] | null
  lastSyncedPageId: string | null
  lastSyncedAt: Date | null
  createdAt: Date
  updatedAt: Date
}): ConnectorSpaceResponse => ({
  id: s.id,
  connectorId: s.connectorId,
  spaceKey: s.spaceKey,
  spaceName: s.spaceName,
  selectedPageIds: s.selectedPageIds ?? null,
  lastSyncedPageId: s.lastSyncedPageId,
  lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
})

const getConfluenceClient = (connector: {
  config: {
    confluenceBaseUrl?: string
    confluenceEmail?: string
    confluenceApiToken?: string
  }
}) => {
  const { confluenceBaseUrl, confluenceEmail, confluenceApiToken } =
    connector.config
  if (!confluenceBaseUrl || !confluenceEmail || !confluenceApiToken) {
    return null
  }
  return new ConfluenceClient({
    baseUrl: confluenceBaseUrl,
    email: confluenceEmail,
    apiToken: confluenceApiToken,
  })
}

const validateSharedRepo = async (
  githubRepoName: string,
  excludeConnectorId?: string,
) => {
  const existing = await listConnectors()
  const others = excludeConnectorId
    ? existing.filter((c) => c.id !== excludeConnectorId)
    : existing

  const conflict = others.find(
    (c) => c.githubRepoName && c.githubRepoName !== githubRepoName,
  )
  if (conflict) {
    return `All connectors must point to the same repository. Existing connector uses "${conflict.githubRepoName}".`
  }
  return null
}

const logToResponse = (l: {
  id: string
  connectorId: string
  status: string
  prNumber: number | null
  prUrl: string | null
  pagesAdded: number | null
  pagesUpdated: number | null
  pagesDeleted: number | null
  errorMessage: string | null
  startedAt: Date
  completedAt: Date | null
}): SyncLogResponse => ({
  id: l.id,
  connectorId: l.connectorId,
  status: l.status,
  prNumber: l.prNumber,
  prUrl: l.prUrl,
  pagesAdded: l.pagesAdded ?? 0,
  pagesUpdated: l.pagesUpdated ?? 0,
  pagesDeleted: l.pagesDeleted ?? 0,
  errorMessage: l.errorMessage,
  startedAt: l.startedAt.toISOString(),
  completedAt: l.completedAt?.toISOString() ?? null,
})

export const connectorRoutes = new OpenAPIHono<AppEnv>()
  .openapi(listConnectorsRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const connectors = await listConnectors()
    return c.json(
      {
        items: connectors.map(connectorToResponse),
      },
      200,
    )
  })
  .openapi(getConnectorRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const id = c.req.param("id")
    const connector = await getConnector(id)
    if (!connector) {
      return c.json({ error: "Not found" }, 404)
    }
    const spaces = await listConnectorSpaces(id)
    const lastSyncLog = await getLatestSyncLog(id)
    return c.json(
      {
        ...connectorToResponse(connector),
        spaces: spaces.map(spaceToResponse),
        lastSyncLog: lastSyncLog ? logToResponse(lastSyncLog) : null,
      },
      200,
    )
  })
  .openapi(createConnectorRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const body = c.req.valid("json")
    try {
      if (body.githubRepoName) {
        const repoConflict = await validateSharedRepo(body.githubRepoName)
        if (repoConflict) {
          return c.json({ error: repoConflict }, 400)
        }
      }
      const connector = await createConnector({
        type: body.type,
        config: body.config,
        githubRepoName: body.githubRepoName,
        githubBranch: body.githubBranch,
      })
      if (body.spaces && body.spaces.length > 0) {
        await createConnectorSpaces({
          connectorId: connector.id,
          spaces: body.spaces,
        })
      }
      return c.json(connectorToResponse(connector), 201)
    } catch (e) {
      console.error("Error creating connector", e)
      if (e instanceof Error && e.message.includes("duplicate")) {
        return c.json({ error: "Connector of this type already exists" }, 409)
      }
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(updateConnectorRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const id = c.req.param("id")
    // @ts-expect-error - zod-openapi typing issue with valid("json")
    const body = c.req.valid("json") as z.infer<
      typeof UpdateConnectorRequestSchema
    >
    try {
      const existing = await getConnector(id)
      if (!existing) {
        return c.json({ error: "Not found" }, 404)
      }
      const updates: Parameters<typeof updateConnector>[1] = {}
      if (body.config) {
        updates.config = body.config
      }
      if (body.enabled !== undefined) {
        if (body.enabled) {
          await enableConnector(id)
        } else {
          await disableConnector(id)
        }
      }
      if (body.githubRepoName !== undefined) {
        const repoConflict = await validateSharedRepo(body.githubRepoName, id)
        if (repoConflict) {
          return c.json({ error: repoConflict }, 400)
        }
        updates.githubRepoName = body.githubRepoName
      }
      if (body.githubBranch !== undefined) {
        updates.githubBranch = body.githubBranch
      }
      if (body.spaces) {
        await createConnectorSpaces({
          connectorId: id,
          spaces: body.spaces,
        })
      }
      const connector = await updateConnector(id, updates)
      if (!connector) {
        return c.json({ error: "Not found" }, 404)
      }
      return c.json(connectorToResponse(connector), 200)
    } catch (e) {
      console.error("Error updating connector", e)
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(deleteConnectorRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const id = c.req.param("id")
    try {
      const deleted = await deleteConnector(id)
      if (!deleted) {
        return c.json({ error: "Not found" }, 404)
      }
      return c.body(null, 204)
    } catch {
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(triggerSyncRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const id = c.req.param("id")
    const connector = await getConnector(id)
    if (!connector) {
      return c.json({ error: "Not found" }, 404)
    }
    try {
      const config = connector.config
      if (
        !config.confluenceBaseUrl ||
        !config.confluenceEmail ||
        !config.confluenceApiToken
      ) {
        return c.json({ error: "Confluence configuration missing" }, 400)
      }
      if (!connector.githubRepoName || !config.githubToken) {
        return c.json({ error: "GitHub configuration missing" }, 400)
      }

      const [owner, repo] = connector.githubRepoName.split("/")
      if (!owner || !repo) {
        return c.json({ error: "Invalid GitHub repository name" }, 400)
      }

      const result = await syncOrchestrator.sync({
        connectorId: id,
        orgId: connector.orgId,
        confluenceConfig: {
          baseUrl: config.confluenceBaseUrl,
          email: config.confluenceEmail,
          apiToken: config.confluenceApiToken,
        },
        githubConfig: {
          token: config.githubToken,
          owner,
          repo,
          branch: connector.githubBranch ?? "main",
        },
        syncMode: config.syncMode,
      })

      if (!result.success) {
        return c.json({ error: result.error ?? "Sync failed" }, 500)
      }

      const syncLog = await getLatestSyncLog(id)
      if (!syncLog) {
        return c.json({ error: "Sync log not found" }, 500)
      }

      return c.json(logToResponse(syncLog), 200)
    } catch (e) {
      console.error("Error triggering sync", e)
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(listAvailableSpacesRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)
    const id = c.req.param("id")
    const connector = await getConnector(id)
    if (!connector) return c.json({ error: "Not found" }, 404)
    const client = getConfluenceClient(connector)
    if (!client) return c.json({ error: "Confluence credentials not configured" }, 400)
    try {
      const spaces = await client.listSpaces()
      console.log(`[spaces] fetched ${spaces.length} spaces for connector ${id}`)
      return c.json({ items: spaces }, 200)
    } catch (e) {
      console.error("Error listing Confluence spaces", e)
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(listSpacePagesRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)
    const id = c.req.param("id")
    const spaceKey = c.req.param("spaceKey")
    const parentId = c.req.query("parentId")
    const connector = await getConnector(id)
    if (!connector) return c.json({ error: "Not found" }, 404)
    const client = getConfluenceClient(connector)
    if (!client) return c.json({ error: "Confluence credentials not configured" }, 400)
    try {
      if (parentId) {
        const pages = await client.getChildPageSummaries(parentId)
        console.log(`[pages] parentId=${parentId} → ${pages.length} children`)
        return c.json({ items: pages }, 200)
      }
      const space = await client.getSpace(spaceKey)
      const pages = await client.getTopLevelPages(space.id, space.homepageId)
      console.log(`[pages] spaceKey=${spaceKey} top-level → ${pages.length} pages`)
      return c.json({ items: pages }, 200)
    } catch (e) {
      console.error("Error listing Confluence pages", e)
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(searchSpacePagesRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)
    const id = c.req.param("id")
    const spaceKey = c.req.param("spaceKey")
    const q = c.req.query("q") ?? ""
    if (!q.trim()) return c.json({ items: [] }, 200)
    const connector = await getConnector(id)
    if (!connector) return c.json({ error: "Not found" }, 404)
    const confluenceClient = getConfluenceClient(connector)
    if (!confluenceClient) return c.json({ error: "Confluence credentials not configured" }, 400)
    try {
      const pages = await confluenceClient.searchPages(spaceKey, q)
      console.log(`[search] spaceKey=${spaceKey} q="${q}" → ${pages.length} results`)
      return c.json({ items: pages }, 200)
    } catch (e) {
      console.error("Error searching Confluence pages", e)
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(saveScopeRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)
    const id = c.req.param("id")
    // @ts-expect-error - zod-openapi typing
    const body = c.req.valid("json") as z.infer<typeof SaveScopeRequestSchema>
    const connector = await getConnector(id)
    if (!connector) return c.json({ error: "Not found" }, 404)
    const config = connector.config
    if (!connector.githubRepoName || !config.githubToken) {
      return c.json({ error: "GitHub configuration missing" }, 400)
    }
    try {
      await replaceConnectorSpaces({
        connectorId: id,
        spaces: body.spaces.map((s) => ({
          spaceKey: s.spaceKey,
          spaceName: s.spaceName,
          selectedPageIds: s.selectedPageIds ?? null,
        })),
      })

      const [owner, repo] = connector.githubRepoName.split("/")
      const result = await syncOrchestrator.syncConfig({
        connectorId: id,
        orgId: connector.orgId,
        confluenceConfig: {
          baseUrl: config.confluenceBaseUrl!,
          email: config.confluenceEmail!,
          apiToken: config.confluenceApiToken!,
        },
        githubConfig: {
          token: config.githubToken,
          owner: owner!,
          repo: repo!,
          branch: connector.githubBranch ?? "main",
        },
        syncMode: config.syncMode,
      })

      if (!result.success) {
        return c.json({ error: result.error ?? "Config sync failed" }, 500)
      }

      return c.json(
        {
          noChange: result.noChange,
          prNumber: result.prNumber ?? null,
          prUrl: result.prUrl ?? null,
        },
        200,
      )
    } catch (e) {
      console.error("Error saving scope", e)
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(listSyncLogsRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const id = c.req.param("id")
    const connector = await getConnector(id)
    if (!connector) {
      return c.json({ error: "Not found" }, 404)
    }
    const limit = c.req.query("limit")
    const logs = await listSyncLogs(id, {
      limit: limit ? parseInt(limit, 10) : 20,
    })
    return c.json(
      {
        items: logs.map((l) => logToResponse(l.connector_sync_logs)),
      },
      200,
    )
  })
