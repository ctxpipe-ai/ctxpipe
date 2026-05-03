import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { getForgeInstallationByConnectionId } from "../../models/atlassian-connector.js"

const CapabilitiesQuery = z.object({
  connectionId: z.string().min(1),
})

const getCap = createRoute({
  method: "get",
  path: "/",
  request: { query: CapabilitiesQuery },
  responses: {
    200: {
      description:
        "Connection-scoped UX hints (non-secret). `confluenceForgeInstallUrl` from `connections.config`, then optional `CONFLUENCE_FORGE_INSTALL_URL` env.",
    },
    404: { description: "Unknown `connectionId` for this org" },
  },
})

export const orgCapabilitiesRoutes = new OpenAPIHono<AppEnv>().openapi(
  getCap,
  async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) {
      return c.json({ error: "Not found" }, 404)
    }
    const connectionId = c.req.query("connectionId")
    if (!connectionId) {
      return c.json({ error: "connectionId is required" }, 400)
    }
    const inst = await getForgeInstallationByConnectionId(orgId, connectionId)
    if (!inst) {
      return c.json({ error: "Forge connection not found" }, 404)
    }
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const fromConfig = inst.confluenceForgeInstallUrl?.trim()
    const url =
      (fromConfig && fromConfig.length > 0 ? fromConfig : null) ??
      env.CONFLUENCE_FORGE_INSTALL_URL?.trim() ??
      null
    return c.json({ confluenceForgeInstallUrl: url }, 200)
  },
)
