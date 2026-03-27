import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  getAtlassianInstanceByOrgId,
  getAtlassianUserAccessToken,
  getForgeInstallationByOrgId,
  listConfluenceSelectionsByOrgId,
  replaceConfluenceSelections,
  upsertAtlassianInstance,
} from "../../models/atlassian-connector.js"

const ErrorResponseSchema = z
  .object({
    error: z.string().optional(),
    message: z.string().optional(),
    why: z.string().optional(),
    code: z.string().optional(),
  })
  .openapi("AtlassianConnectorErrorResponse")

const AtlassianStatusResponseSchema = z
  .object({
    isLinked: z.boolean(),
    isInstalled: z.boolean(),
    installationStatus: z.string().nullable(),
    selectedPageCount: z.number(),
    linkedSite: z
      .object({
        cloudId: z.string(),
        siteUrl: z.string().url(),
        siteName: z.string().nullable(),
      })
      .nullable(),
  })
  .openapi("AtlassianConnectorStatusResponse")

const AtlassianLinkBodySchema = z
  .object({
    cloudId: z.string().optional(),
    siteUrl: z.string().url().optional(),
  })
  .openapi("AtlassianConnectorLinkBody")

const AtlassianLinkResponseSchema = z
  .object({
    id: z.string(),
    orgId: z.string(),
    cloudId: z.string(),
    siteUrl: z.string().url(),
    siteName: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("AtlassianConnectorLinkResponse")

const ConfluenceSpaceSchema = z
  .object({
    id: z.string(),
    key: z.string().nullable(),
    name: z.string(),
  })
  .openapi("ConfluenceSpace")

const ConfluencePageSchema = z
  .object({
    id: z.string(),
    title: z.string(),
  })
  .openapi("ConfluencePage")

const ConfluenceSpacesResponseSchema = z
  .object({ spaces: z.array(ConfluenceSpaceSchema) })
  .openapi("ConfluenceSpacesResponse")

const ConfluencePagesResponseSchema = z
  .object({ pages: z.array(ConfluencePageSchema) })
  .openapi("ConfluencePagesResponse")

const SaveConfluenceSelectionBodySchema = z
  .object({
    selections: z.array(
      z.object({
        spaceId: z.string(),
        spaceKey: z.string().optional(),
        spaceName: z.string().optional(),
        pageId: z.string(),
        pageTitle: z.string().optional(),
      }),
    ),
  })
  .openapi("SaveConfluenceSelectionBody")

const SaveConfluenceSelectionResponseSchema = z
  .object({
    savedCount: z.number(),
  })
  .openapi("SaveConfluenceSelectionResponse")

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

const postLinkRoute = createRoute({
  method: "post",
  path: "/link",
  request: {
    body: {
      content: {
        "application/json": {
          schema: AtlassianLinkBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: AtlassianLinkResponseSchema,
        },
      },
      description: "Linked Atlassian site for this org",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Atlassian account not linked or no Atlassian sites found",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid cloudId/siteUrl input",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
  },
})

const getSpacesRoute = createRoute({
  method: "get",
  path: "/spaces",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ConfluenceSpacesResponseSchema,
        },
      },
      description: "List Confluence spaces for linked Atlassian site",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Linked Atlassian site not found",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Atlassian token is unavailable",
    },
  },
})

const getPagesRoute = createRoute({
  method: "get",
  path: "/spaces/:spaceId/pages",
  request: {
    params: z.object({
      spaceId: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ConfluencePagesResponseSchema,
        },
      },
      description: "List Confluence pages under a space",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Linked Atlassian site not found",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Atlassian token is unavailable",
    },
  },
})

const putSelectionRoute = createRoute({
  method: "put",
  path: "/selection",
  request: {
    body: {
      content: {
        "application/json": {
          schema: SaveConfluenceSelectionBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: SaveConfluenceSelectionResponseSchema,
        },
      },
      description: "Saved Confluence page selection",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Linked Atlassian site not found",
    },
  },
})

type AccessibleResource = {
  id: string
  url: string
  name: string
}

async function getAccessibleResources(
  accessToken: string,
): Promise<AccessibleResource[]> {
  const res = await fetch(
    "https://api.atlassian.com/oauth/token/accessible-resources",
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    },
  )
  if (!res.ok) {
    throw new Error("Failed to fetch Atlassian sites")
  }
  const json = (await res.json()) as Array<{
    id?: string
    url?: string
    name?: string
  }>
  return json
    .filter((item): item is { id: string; url: string; name: string } =>
      Boolean(item.id && item.url && item.name),
    )
    .map((item) => ({
      id: item.id,
      url: item.url,
      name: item.name,
    }))
}

async function getConfluenceTokenForOrg(input: {
  orgId: string
  userId: string
}): Promise<string | undefined> {
  const forgeInstallation = await getForgeInstallationByOrgId(input.orgId)
  if (forgeInstallation?.appSystemToken) {
    return forgeInstallation.appSystemToken
  }
  return getAtlassianUserAccessToken(input.userId)
}

async function fetchConfluence(
  cloudId: string,
  token: string,
  path: string,
): Promise<unknown> {
  const res = await fetch(`https://api.atlassian.com/ex/confluence/${cloudId}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  })
  if (!res.ok) {
    throw new Error(`Confluence API request failed (${res.status})`)
  }
  return res.json()
}

export const atlassianConnectorRoutes = new OpenAPIHono<AppEnv>()
  .openapi(getStatusRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)

    const [instance, installation, selections] = await Promise.all([
      getAtlassianInstanceByOrgId(orgId),
      getForgeInstallationByOrgId(orgId),
      listConfluenceSelectionsByOrgId(orgId),
    ])

    return c.json(
      {
        isLinked: Boolean(instance),
        isInstalled: installation?.status === "installed",
        installationStatus: installation?.status ?? null,
        selectedPageCount: selections.length,
        linkedSite: instance
          ? {
              cloudId: instance.cloudId,
              siteUrl: instance.siteUrl,
              siteName: instance.siteName ?? null,
            }
          : null,
      },
      200,
    )
  })
  .openapi(postLinkRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const user = c.get("user") as { id: string }
    const body = c.req.valid("json")

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

    const resources = await getAccessibleResources(accessToken)
    if (resources.length === 0) {
      return c.json(
        {
          error: "No Atlassian site found for this account",
          code: "atlassian_site_not_found",
        },
        409,
      )
    }

    const firstResource = resources[0]
    if (!firstResource) {
      return c.json(
        {
          error: "No Atlassian site found for this account",
          code: "atlassian_site_not_found",
        },
        409,
      )
    }

    let selected = firstResource
    if (body.cloudId) {
      const byCloud = resources.find((resource) => resource.id === body.cloudId)
      if (!byCloud) {
        return c.json({ error: "Invalid cloudId for current Atlassian account" }, 400)
      }
      selected = byCloud
    } else if (body.siteUrl) {
      const byUrl = resources.find((resource) => resource.url === body.siteUrl)
      if (!byUrl) {
        return c.json({ error: "Invalid siteUrl for current Atlassian account" }, 400)
      }
      selected = byUrl
    }

    const row = await upsertAtlassianInstance({
      orgId,
      cloudId: selected.id,
      siteUrl: selected.url,
      siteName: selected.name,
      linkedByUserId: user.id,
    })

    return c.json(
      {
        id: row.id,
        orgId: row.orgId,
        cloudId: row.cloudId,
        siteUrl: row.siteUrl,
        siteName: row.siteName ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
      200,
    )
  })
  .openapi(getSpacesRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const user = c.get("user") as { id: string }

    const instance = await getAtlassianInstanceByOrgId(orgId)
    if (!instance) {
      return c.json({ error: "Atlassian site is not linked for this org" }, 404)
    }

    const token = await getConfluenceTokenForOrg({ orgId, userId: user.id })
    if (!token) {
      return c.json({ error: "No Atlassian token available for this org" }, 409)
    }

    const json = (await fetchConfluence(
      instance.cloudId,
      token,
      "/wiki/api/v2/spaces?limit=250",
    )) as {
      results?: Array<{ id?: string; key?: string; name?: string }>
    }

    const spaces = (json.results ?? [])
      .filter((space): space is { id: string; key?: string; name?: string } =>
        Boolean(space.id),
      )
      .map((space) => ({
        id: space.id,
        key: space.key ?? null,
        name: space.name ?? space.id,
      }))

    return c.json({ spaces }, 200)
  })
  .openapi(getPagesRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const user = c.get("user") as { id: string }
    const spaceId = c.req.param("spaceId")

    const instance = await getAtlassianInstanceByOrgId(orgId)
    if (!instance) {
      return c.json({ error: "Atlassian site is not linked for this org" }, 404)
    }

    const token = await getConfluenceTokenForOrg({ orgId, userId: user.id })
    if (!token) {
      return c.json({ error: "No Atlassian token available for this org" }, 409)
    }

    const json = (await fetchConfluence(
      instance.cloudId,
      token,
      `/wiki/api/v2/pages?space-id=${encodeURIComponent(spaceId)}&limit=250`,
    )) as { results?: Array<{ id?: string; title?: string }> }

    const pages = (json.results ?? [])
      .filter((page): page is { id: string; title?: string } => Boolean(page.id))
      .map((page) => ({
        id: page.id,
        title: page.title ?? page.id,
      }))

    return c.json({ pages }, 200)
  })
  .openapi(putSelectionRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const body = c.req.valid("json")
    const instance = await getAtlassianInstanceByOrgId(orgId)
    if (!instance) {
      return c.json({ error: "Atlassian site is not linked for this org" }, 404)
    }

    const rows = await replaceConfluenceSelections({
      orgId,
      cloudId: instance.cloudId,
      items: body.selections,
    })
    return c.json({ savedCount: rows.length }, 200)
  })
