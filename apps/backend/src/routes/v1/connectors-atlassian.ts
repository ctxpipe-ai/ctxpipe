import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { atlassianInstallationRoutes } from "./atlassian-installation.js"
import {
  getAtlassianUserAccessToken,
  getForgeInstallationByOrgId,
  listConfluenceSelectionsByOrgId,
  replaceConfluenceSelections,
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
  .route("/installation", atlassianInstallationRoutes)
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
      return c.json({ error: "Atlassian Forge app is not installed for this org" }, 404)
    }

    const token = await getConfluenceTokenForOrg({ orgId, userId: user.id })
    if (!token) {
      return c.json({ error: "No Atlassian token available for this org" }, 409)
    }

    const json = (await fetchConfluence(
      installation.cloudId,
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
      return c.json({ error: "Atlassian Forge app is not installed for this org" }, 404)
    }

    const token = await getConfluenceTokenForOrg({ orgId, userId: user.id })
    if (!token) {
      return c.json({ error: "No Atlassian token available for this org" }, 409)
    }

    const json = (await fetchConfluence(
      installation.cloudId,
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
    const installation = await getForgeInstallationByOrgId(orgId)
    if (!installation?.cloudId || installation.status !== "installed") {
      return c.json({ error: "Atlassian Forge app is not installed for this org" }, 404)
    }

    const rows = await replaceConfluenceSelections({
      orgId,
      cloudId: installation.cloudId,
      items: body.selections,
    })
    return c.json({ savedCount: rows.length }, 200)
  })
