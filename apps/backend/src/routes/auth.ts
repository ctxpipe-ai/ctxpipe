import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider"
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client"
import { createAuthClient } from "better-auth/client"
import type { Hono } from "hono"
import type { AppEnv } from "../app/env.js"
import { getAuth } from "../auth/config.js"

export function registerAuthRoutes(app: Hono<AppEnv>) {
  const auth = getAuth()
  const serverClient = createAuthClient({
    plugins: [oauthProviderResourceClient()],
  })
  app.on(["GET", "POST"], "/.auth/*", (c) => auth.handler(c.req.raw))

  app.get("/.well-known/oauth-authorization-server/api/auth", (c) =>
    oauthProviderAuthServerMetadata(auth)(c.req.raw),
  )

  app.get("/.well-known/openid-configuration", (c) =>
    oauthProviderOpenIdConfigMetadata(auth)(c.req.raw),
  )

  app.get("/:orgSlug/.well-known/oauth-protected-resource/mcp", async (c) => {
    const orgSlug = c.req.param("orgSlug")
    const authorizationServer = c.var.env.AUTH_ISSUER ?? c.var.env.AUTH_BASE_URL
    const metadata = await serverClient.getProtectedResourceMetadata({
      resource: `${c.var.env.AUTH_BASE_URL}/${orgSlug}/mcp`,
      authorization_servers: [authorizationServer],
    })
    return c.json(metadata, 200, {
      "Cache-Control":
        "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400",
    })
  })
  return app
}
