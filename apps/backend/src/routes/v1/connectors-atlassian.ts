import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { resolveAtlassianConfluenceApiBaseUrl } from "../../lib/atlassian-api-base-url.js"
import {
  deleteForgeInstallationByOrgId,
  type ForgeInstallation,
  getAtlassianUserAccessToken,
  getForgeInstallationByOrgId,
  getPendingForgeInstallationForUserInOtherOrg,
  listConfluenceSpacesByForgeInstallationId,
  patchAtlassianConnectorConfig,
  upsertPendingForgeInstallation,
} from "../../models/atlassian-connector.js"
import { getConfluenceSyncTargetByOrgId } from "../../models/confluence-sync-target.js"
import { getInstallationByOrgId } from "../../models/github-installation.js"
import { ow } from "../../openworkflow/client.js"
import { confluenceSyncContent } from "../../openworkflow/confluence-sync-content.js"

const ErrorResponseSchema = z
  .object({
    error: z.string().optional(),
    message: z.string().optional(),
    why: z.string().optional(),
    code: z.string().optional(),
  })
  .openapi("AtlassianConnectorErrorResponse")

const AtlassianStatusSpacePreviewSchema = z
  .object({
    spaceKey: z.string(),
    spaceName: z.string().nullable(),
  })
  .openapi("AtlassianStatusSpacePreview")

const AtlassianStatusSyncTargetPreviewSchema = z
  .object({
    repositoryName: z.string(),
    branch: z.string(),
  })
  .openapi("AtlassianStatusSyncTargetPreview")

const AtlassianStatusResponseSchema = z
  .object({
    isLinked: z.boolean(),
    isInstalled: z.boolean(),
    installationStatus: z.string().nullable(),
    isGithubLinked: z.boolean(),
    selectedSpaceCount: z.number(),
    syncTargetConfigured: z.boolean(),
    syncTarget: AtlassianStatusSyncTargetPreviewSchema.nullable(),
    selectedSpaces: z.array(AtlassianStatusSpacePreviewSchema),
  })
  .openapi("AtlassianConnectorStatusResponse")

const AtlassianInstallationSchema = z
  .object({
    id: z.string(),
    orgId: z.string(),
    cloudId: z.string().nullable(),
    status: z.string(),
    installedByUserId: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("AtlassianInstallation")

const registerAtlassianInstallationRoute = createRoute({
  method: "post",
  path: "/installation",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: AtlassianInstallationSchema,
        },
      },
      description: "Atlassian install intent registered for this org",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Atlassian account is not linked or user already has pending install intent in another org",
    },
  },
})

const getStatusRoute = createRoute({
  method: "get",
  path: "/status",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: AtlassianStatusResponseSchema,
        },
      },
      description: "Current Atlassian connector setup status for this org",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

const ScopedSpaceSchema = z.object({
  spaceKey: z.string(),
  spaceName: z.string().optional(),
  selectedPageIds: z.array(z.string()).nullable().optional(),
})

const SaveSyncTargetSchema = z.object({
  repositoryName: z.string().min(1),
  branch: z.string().min(1),
  enabled: z.boolean(),
})

const AtlassianPatchConfigRequestSchema = z
  .object({
    spaces: z.array(ScopedSpaceSchema).optional(),
    syncTarget: SaveSyncTargetSchema.optional(),
  })
  .refine(
    (body) => body.spaces !== undefined || body.syncTarget !== undefined,
    { message: "Provide at least one of spaces or syncTarget" },
  )
  .openapi("AtlassianPatchConfigRequest")

const ConfluenceSpaceInfoSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    type: z.string(),
  })
  .openapi("AtlassianConfluenceSpaceInfo")

const ConfluencePageSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    spaceId: z.string(),
    parentId: z.string().optional(),
  })
  .openapi("AtlassianConfluencePageSummary")

const ConfluenceScopeRowSchema = z
  .object({
    id: z.string(),
    forgeInstallationId: z.string(),
    spaceKey: z.string(),
    spaceName: z.string().nullable(),
    selectedPageIds: z.array(z.string()).nullable(),
    lastSyncedPageId: z.string().nullable(),
    lastSyncedAt: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("AtlassianConfluenceScopeRow")

const ConfluenceSyncTargetSchema = z
  .object({
    id: z.string(),
    orgId: z.string(),
    forgeInstallationId: z.string(),
    repositoryName: z.string(),
    branch: z.string(),
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("ConfluenceSyncTarget")

const AtlassianConnectorConfigSchema = z
  .object({
    spaces: z.array(ConfluenceScopeRowSchema),
    syncTarget: ConfluenceSyncTargetSchema.nullable(),
  })
  .openapi("AtlassianConnectorConfig")

const listAvailableSpacesRoute = createRoute({
  method: "get",
  path: "/available-spaces",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ items: z.array(ConfluenceSpaceInfoSchema) }),
        },
      },
      description: "List available Confluence spaces for the org installation",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forge installation/token not ready",
    },
  },
})

const listSpacePagesRoute = createRoute({
  method: "get",
  path: "/available-spaces/{spaceKey}/pages",
  request: {
    params: z.object({ spaceKey: z.string() }),
    query: z.object({ parentId: z.string().optional() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ items: z.array(ConfluencePageSummarySchema) }),
        },
      },
      description: "List top-level pages or child pages in a space",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forge installation/token not ready",
    },
  },
})

const searchSpacePagesRoute = createRoute({
  method: "get",
  path: "/available-spaces/{spaceKey}/search",
  request: {
    params: z.object({ spaceKey: z.string() }),
    query: z.object({ q: z.string().optional() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ items: z.array(ConfluencePageSummarySchema) }),
        },
      },
      description: "Search pages within a Confluence space by title",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forge installation/token not ready",
    },
  },
})

const getConfigRoute = createRoute({
  method: "get",
  path: "/config",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: AtlassianConnectorConfigSchema,
        },
      },
      description: "Current Atlassian connector config",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forge installation/token not ready",
    },
  },
})

const deleteAtlassianConnectorRoute = createRoute({
  method: "delete",
  path: "/",
  responses: {
    204: {
      description:
        "Atlassian connector removed for this organization (idempotent)",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

const patchConfigRoute = createRoute({
  method: "patch",
  path: "/config",
  request: {
    body: {
      content: {
        "application/json": {
          schema: AtlassianPatchConfigRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            accepted: z.literal(true),
            savedCount: z.number(),
            syncEnqueued: z.boolean(),
            workflowName: z.string().optional(),
          }),
        },
      },
      description:
        "Config patched; Confluence content sync workflow runs when `spaces` is present in the body",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid or empty patch body",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forge installation/token not ready",
    },
  },
})

type InstalledForgeContext = {
  installation: {
    id: string
    cloudId: string
    atlassianApiBaseUrl: string | null
    appSystemToken: string
  }
}

async function getInstalledForgeContext(
  orgId: string,
): Promise<InstalledForgeContext | undefined> {
  const installation = await getForgeInstallationByOrgId(orgId)
  if (
    !installation ||
    installation.status !== "installed" ||
    !installation.cloudId
  ) {
    return undefined
  }
  if (!installation.appSystemToken) {
    return undefined
  }
  return {
    installation: {
      id: installation.id,
      cloudId: installation.cloudId,
      atlassianApiBaseUrl: installation.atlassianApiBaseUrl,
      appSystemToken: installation.appSystemToken,
    },
  }
}

async function fetchConfluence<T>(
  installation: { cloudId: string; atlassianApiBaseUrl: string | null },
  token: string,
  path: string,
): Promise<T> {
  const base = resolveAtlassianConfluenceApiBaseUrl(installation)
  const res = await fetch(`${base}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  })
  if (!res.ok) {
    throw new Error(`Confluence API request failed (${res.status})`)
  }
  return (await res.json()) as T
}

async function listSpaces(input: {
  installation: { cloudId: string; atlassianApiBaseUrl: string | null }
  token: string
}) {
  const items: Array<{ id: string; key: string; name: string; type: string }> =
    []
  let cursor: string | undefined

  while (true) {
    const params = new URLSearchParams({ limit: "250" })
    if (cursor) params.set("cursor", cursor)
    const data = await fetchConfluence<{
      results: Array<{ id: string; key: string; name: string; type: string }>
      _links?: { next?: string }
    }>(
      input.installation,
      input.token,
      `/wiki/api/v2/spaces?${params.toString()}`,
    )
    items.push(...data.results)
    const next = data._links?.next
    if (!next) break
    cursor =
      new URL(next, "https://dummy.invalid").searchParams.get("cursor") ??
      undefined
    if (!cursor) break
  }

  return items
}

async function getSpaceByKey(input: {
  installation: { cloudId: string; atlassianApiBaseUrl: string | null }
  token: string
  spaceKey: string
}) {
  const data = await fetchConfluence<{
    results: Array<{
      id: string
      key: string
      name: string
      type: string
      homepageId?: string
    }>
  }>(
    input.installation,
    input.token,
    `/wiki/api/v2/spaces?keys=${encodeURIComponent(input.spaceKey)}&limit=250`,
  )
  return data.results.find((space) => space.key === input.spaceKey)
}

async function listTopLevelPages(input: {
  installation: { cloudId: string; atlassianApiBaseUrl: string | null }
  token: string
  spaceId: string
  homepageId?: string
}) {
  if (input.homepageId) {
    return fetchConfluence<{
      results: Array<{
        id: string
        title: string
        spaceId?: string
        parentId?: string
      }>
    }>(
      input.installation,
      input.token,
      `/wiki/api/v2/pages/${input.homepageId}/children?limit=100`,
    )
  }
  return fetchConfluence<{
    results: Array<{
      id: string
      title: string
      spaceId?: string
      parentId?: string
    }>
  }>(
    input.installation,
    input.token,
    `/wiki/api/v2/pages?spaceId=${encodeURIComponent(input.spaceId)}&depth=root&limit=100&status=current`,
  )
}

async function searchPages(input: {
  installation: { cloudId: string; atlassianApiBaseUrl: string | null }
  token: string
  spaceKey: string
  q: string
}) {
  const base = resolveAtlassianConfluenceApiBaseUrl(input.installation)
  const safeQuery = input.q.replace(/"/g, "").replace(/\*/g, "").trim()
  const cql = `type=page AND space.key="${input.spaceKey}" AND title ~ "*${safeQuery}*"`
  const params = new URLSearchParams({
    cql,
    limit: "25",
    expand: "space",
  })
  const res = await fetch(
    `${base}/wiki/rest/api/content/search?${params.toString()}`,
    {
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: "application/json",
      },
    },
  )
  if (!res.ok) {
    throw new Error(`Confluence API request failed (${res.status})`)
  }
  const json = (await res.json()) as {
    results: Array<{ id: string; title: string; space?: { id?: string } }>
  }
  return json.results.map((result) => ({
    id: result.id,
    title: result.title,
    spaceId: result.space?.id ?? "",
  }))
}

export const atlassianConnectorRoutes = new OpenAPIHono<AppEnv>()
  .openapi(registerAtlassianInstallationRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)

    const user = c.get("user") as { id: string }
    const accessToken = await getAtlassianUserAccessToken(user.id)
    if (!accessToken) {
      return c.json(
        {
          error: "Atlassian account not linked",
          code: "atlassian_not_linked",
        },
        409,
      )
    }

    const pendingInOtherOrg =
      await getPendingForgeInstallationForUserInOtherOrg({
        userId: user.id,
        orgId,
      })
    if (pendingInOtherOrg) {
      return c.json(
        {
          error:
            "A pending Atlassian installation already exists for this user in another organization",
          code: "atlassian_pending_installation_exists",
        },
        409,
      )
    }

    let row: ForgeInstallation
    try {
      row = await upsertPendingForgeInstallation({
        orgId,
        installedByUserId: user.id,
      })
    } catch (error) {
      const dbError = error as { code?: string } | undefined
      if (dbError?.code === "23505") {
        return c.json(
          {
            error:
              "A pending Atlassian installation already exists for this user in another organization",
            code: "atlassian_pending_installation_exists",
          },
          409,
        )
      }
      throw error
    }

    return c.json(
      {
        id: row.id,
        orgId: row.orgId,
        cloudId: row.cloudId ?? null,
        status: row.status,
        installedByUserId: row.installedByUserId ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
      200,
    )
  })
  .openapi(getStatusRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const user = c.get("user") as { id: string }

    const [accessToken, installation, githubInstallation, syncTarget] =
      await Promise.all([
        getAtlassianUserAccessToken(user.id),
        getForgeInstallationByOrgId(orgId),
        getInstallationByOrgId(orgId),
        getConfluenceSyncTargetByOrgId(orgId),
      ])

    const scopeRows = installation
      ? await listConfluenceSpacesByForgeInstallationId(installation.id)
      : []

    return c.json(
      {
        isLinked: Boolean(accessToken),
        isInstalled:
          installation?.status === "installed" && Boolean(installation.cloudId),
        installationStatus: installation?.status ?? null,
        isGithubLinked: Boolean(githubInstallation),
        selectedSpaceCount: scopeRows.length,
        syncTargetConfigured: Boolean(syncTarget),
        syncTarget: syncTarget
          ? {
              repositoryName: syncTarget.repositoryName,
              branch: syncTarget.branch,
            }
          : null,
        selectedSpaces: scopeRows.map((r) => ({
          spaceKey: r.spaceKey,
          spaceName: r.spaceName ?? null,
        })),
      },
      200,
    )
  })
  .openapi(listAvailableSpacesRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const installed = await getInstalledForgeContext(orgId)
    if (!installed) {
      return c.json(
        { error: "Forge app is not installed or token is unavailable" },
        409,
      )
    }

    const items = await listSpaces({
      installation: installed.installation,
      token: installed.installation.appSystemToken,
    })
    return c.json({ items }, 200)
  })
  .openapi(listSpacePagesRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const installed = await getInstalledForgeContext(orgId)
    if (!installed) {
      return c.json(
        { error: "Forge app is not installed or token is unavailable" },
        409,
      )
    }
    const spaceKey = c.req.param("spaceKey")
    const parentId = c.req.query("parentId")

    if (parentId) {
      const data = await fetchConfluence<{
        results: Array<{
          id: string
          title: string
          spaceId?: string
          parentId?: string
        }>
      }>(
        installed.installation,
        installed.installation.appSystemToken,
        `/wiki/api/v2/pages/${parentId}/children?limit=100`,
      )
      return c.json(
        {
          items: data.results.map((page) => ({
            id: page.id,
            title: page.title,
            spaceId: page.spaceId ?? "",
            parentId: page.parentId,
          })),
        },
        200,
      )
    }

    const space = await getSpaceByKey({
      installation: installed.installation,
      token: installed.installation.appSystemToken,
      spaceKey,
    })
    if (!space) return c.json({ items: [] }, 200)
    const pages = await listTopLevelPages({
      installation: installed.installation,
      token: installed.installation.appSystemToken,
      spaceId: space.id,
      homepageId: space.homepageId,
    })
    return c.json(
      {
        items: pages.results.map((page) => ({
          id: page.id,
          title: page.title,
          spaceId: page.spaceId ?? space.id,
          parentId: page.parentId,
        })),
      },
      200,
    )
  })
  .openapi(searchSpacePagesRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const installed = await getInstalledForgeContext(orgId)
    if (!installed) {
      return c.json(
        { error: "Forge app is not installed or token is unavailable" },
        409,
      )
    }
    const spaceKey = c.req.param("spaceKey")
    const q = c.req.query("q")
    if (!q || !q.trim()) return c.json({ items: [] }, 200)
    const items = await searchPages({
      installation: installed.installation,
      token: installed.installation.appSystemToken,
      spaceKey,
      q,
    })
    return c.json({ items }, 200)
  })
  .openapi(getConfigRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const installation = await getForgeInstallationByOrgId(orgId)
    if (
      !installation ||
      installation.status !== "installed" ||
      !installation.cloudId
    ) {
      return c.json({ error: "Forge app is not installed" }, 409)
    }
    const [rows, syncTarget] = await Promise.all([
      listConfluenceSpacesByForgeInstallationId(installation.id),
      getConfluenceSyncTargetByOrgId(orgId),
    ])
    return c.json(
      {
        spaces: rows.map((row) => ({
          id: row.id,
          forgeInstallationId: row.forgeInstallationId,
          spaceKey: row.spaceKey,
          spaceName: row.spaceName ?? null,
          selectedPageIds: (row.selectedPageIds as string[] | null) ?? null,
          lastSyncedPageId: row.lastSyncedPageId ?? null,
          lastSyncedAt: row.lastSyncedAt
            ? row.lastSyncedAt.toISOString()
            : null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
        syncTarget: syncTarget
          ? {
              id: syncTarget.id,
              orgId: syncTarget.orgId,
              forgeInstallationId: syncTarget.forgeInstallationId,
              repositoryName: syncTarget.repositoryName,
              branch: syncTarget.branch,
              enabled: syncTarget.enabled,
              createdAt: syncTarget.createdAt.toISOString(),
              updatedAt: syncTarget.updatedAt.toISOString(),
            }
          : null,
      },
      200,
    )
  })
  .openapi(patchConfigRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const installation = await getForgeInstallationByOrgId(orgId)
    if (
      !installation ||
      installation.status !== "installed" ||
      !installation.cloudId
    ) {
      return c.json({ error: "Forge app is not installed" }, 409)
    }
    const body = c.req.valid("json")
    const { spaces: spacesPatch, syncTarget } = body
    const syncEnqueued = spacesPatch !== undefined

    const saved = await patchAtlassianConnectorConfig({
      orgId,
      forgeInstallationId: installation.id,
      ...(spacesPatch !== undefined
        ? {
            spaces: spacesPatch.map((space) => ({
              spaceKey: space.spaceKey,
              spaceName: space.spaceName,
              selectedPageIds: space.selectedPageIds ?? null,
            })),
          }
        : {}),
      ...(syncTarget !== undefined ? { syncTarget } : {}),
    })

    if (syncEnqueued) {
      void ow.runWorkflow(confluenceSyncContent.spec, {
        orgId,
        orgSlug: c.req.param("orgSlug"),
        forgeInstallationId: installation.id,
      })
    }

    return c.json(
      {
        accepted: true as const,
        savedCount: saved.spaces.length,
        syncEnqueued,
        ...(syncEnqueued
          ? { workflowName: confluenceSyncContent.spec.name }
          : {}),
      },
      200,
    )
  })
  .openapi(deleteAtlassianConnectorRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    await deleteForgeInstallationByOrgId(orgId)
    return c.body(null, 204)
  })
