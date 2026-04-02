import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { resolveAtlassianConfluenceApiBaseUrl } from "../../lib/atlassian-api-base-url.js"
import {
  getAtlassianUserAccessToken,
  getForgeInstallationByOrgId,
  getPendingForgeInstallationForUserInOtherOrg,
  listConfluenceSelectionsByOrgId,
  replaceConfluenceSelections,
  type ForgeInstallation,
  upsertPendingForgeInstallation,
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
  })
  .openapi("AtlassianConnectorStatusResponse")

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
  installation: { cloudId: string; atlassianApiBaseUrl: string | null },
  token: string,
  path: string,
): Promise<unknown> {
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
  return res.json()
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

    const pendingInOtherOrg = await getPendingForgeInstallationForUserInOtherOrg({
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

    const [accessToken, installation, selections] = await Promise.all([
      getAtlassianUserAccessToken(user.id),
      getForgeInstallationByOrgId(orgId),
      listConfluenceSelectionsByOrgId(orgId),
    ])

    return c.json(
      {
        isLinked: Boolean(accessToken),
        isInstalled:
          installation?.status === "installed" && Boolean(installation.cloudId),
        installationStatus: installation?.status ?? null,
        selectedPageCount: selections.length,
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

    const installation = await getForgeInstallationByOrgId(orgId)
    if (!installation?.cloudId || installation.status !== "installed") {
      return c.json(
        { error: "Atlassian Forge app is not installed for this org" },
        404,
      )
    }

    const token = await getConfluenceTokenForOrg({ orgId, userId: user.id })
    if (!token) {
      return c.json({ error: "No Atlassian token available for this org" }, 409)
    }

    const json = (await fetchConfluence(
      { cloudId: installation.cloudId, atlassianApiBaseUrl: installation.atlassianApiBaseUrl },
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

    const installation = await getForgeInstallationByOrgId(orgId)
    if (!installation?.cloudId || installation.status !== "installed") {
      return c.json(
        { error: "Atlassian Forge app is not installed for this org" },
        404,
      )
    }


    const token = await getConfluenceTokenForOrg({ orgId, userId: user.id })
    if (!token) {
      return c.json({ error: "No Atlassian token available for this org" }, 409)
    }

    const json = (await fetchConfluence(
      { cloudId: installation.cloudId, atlassianApiBaseUrl: installation.atlassianApiBaseUrl },
      token,
      `/wiki/api/v2/pages?space-id=${encodeURIComponent(spaceId)}&limit=250`,
    )) as { results?: Array<{ id?: string; title?: string }> }

    const pages = (json.results ?? [])
      .filter((page): page is { id: string; title?: string } =>
        Boolean(page.id),
      )
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
    const installation = await getForgeInstallationByOrgId(orgId)
    if (!installation?.cloudId || installation.status !== "installed") {
      return c.json(
        { error: "Atlassian Forge app is not installed for this org" },
        404,
      )
    }

    const rows = await replaceConfluenceSelections({
      orgId,
      cloudId: installation.cloudId,
      items: body.selections,
    })
    return c.json({ savedCount: rows.length }, 200)
  })
