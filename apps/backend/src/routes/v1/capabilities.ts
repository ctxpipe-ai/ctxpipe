import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { getForgeInstallationByConnectionId } from "../../models/atlassian-connector.js"
import {
  type ConnectionRow,
  githubConnectionToShape,
  githubRowHasAppCredentials,
} from "../../models/connection-rows.js"
import { getGithubConnectionRow } from "../../models/github-installation.js"
import { getLinearConnectionByConnectionId } from "../../models/linear-connector.js"

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
        "Connection-scoped UX hints (non-secret): Forge install URL and/or GitHub webhook / install hints.",
    },
    400: { description: "Missing query parameter" },
    404: { description: "Unknown `connectionId` for this org" },
  },
})

function githubCapabilitiesFromRow(
  row: ConnectionRow,
  connectionId: string,
  env: AppEnv["Variables"]["env"],
) {
  const shape = githubConnectionToShape(row)
  const hasCred = githubRowHasAppCredentials(row, env)
  const publicApiOrigin = env.AUTH_BASE_URL.replace(/\/$/, "")
  const webhookUrl = `${publicApiOrigin}/api/v1/webhook/github/${connectionId}`
  const slug = shape.appSlug?.trim()
  const installSelectUrl = slug
    ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`
    : null
  return {
    githubWebhookUrl: webhookUrl,
    githubAppInstallSelectUrl: installSelectUrl,
    githubInstallationLinked: shape.installationId != null,
    needsGithubAppCredentials: !hasCred,
  }
}

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

    const forge = await getForgeInstallationByConnectionId(orgId, connectionId)
    if (forge) {
      const env = c.var.env
      const fromConfig = forge.confluenceForgeInstallUrl?.trim()
      const url =
        (fromConfig && fromConfig.length > 0 ? fromConfig : null) ??
        env.CONFLUENCE_FORGE_INSTALL_URL?.trim() ??
        null
      return c.json({ confluenceForgeInstallUrl: url }, 200)
    }

    const ghRow = await getGithubConnectionRow(orgId, connectionId)
    if (ghRow) {
      return c.json(
        githubCapabilitiesFromRow(ghRow, connectionId, c.var.env),
        200,
      )
    }

    const linear = await getLinearConnectionByConnectionId(
      orgId,
      connectionId,
      c.var.env,
    )
    if (linear) {
      const publicApiOrigin = c.var.env.AUTH_BASE_URL.replace(/\/$/, "")
      return c.json(
        {
          linearOauthConfigured: Boolean(
            c.var.env.LINEAR_CLIENT_ID && c.var.env.LINEAR_CLIENT_SECRET,
          ),
          linearWorkspaceName: linear.workspaceName,
          linearWebhookUrl: `${publicApiOrigin}/api/v1/webhook/linear`,
        },
        200,
      )
    }

    return c.json({ error: "Connection not found" }, 404)
  },
)
