import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider"
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client"
import { createAuthClient } from "better-auth/client"
import type { Hono } from "hono"
import type { AppEnv } from "../app/env.js"
import { registerOAuthResourceAudience } from "../auth/audiences.js"
import { getAuth } from "../auth/config.js"

export function registerAuthRoutes(app: Hono<AppEnv>) {
  const auth = getAuth()
  const serverClient = createAuthClient({
    plugins: [oauthProviderResourceClient()],
  })
  const registerAudienceFromRequest = async (
    request: Request,
    authBaseUrl: string,
  ) => {
    const requestUrl = new URL(request.url)
    const queryResource = requestUrl.searchParams.get("resource")
    if (queryResource) {
      registerOAuthResourceAudience(queryResource, authBaseUrl)
      return
    }

    if (request.method !== "POST") {
      return
    }
    const contentType = request.headers.get("content-type") ?? ""
    if (!contentType.includes("application/x-www-form-urlencoded")) {
      return
    }

    const formBody = await request.clone().text()
    const formResource = new URLSearchParams(formBody).get("resource")
    if (formResource) {
      registerOAuthResourceAudience(formResource, authBaseUrl)
    }
  }
  app.use("/.auth/api/v1", async (c, next) => {
    await registerAudienceFromRequest(c.req.raw, c.var.env.AUTH_BASE_URL)
    await next()
  })
  app.use("/.auth/api/v1/*", async (c, next) => {
    await registerAudienceFromRequest(c.req.raw, c.var.env.AUTH_BASE_URL)
    await next()
  })
  app.on(["GET", "POST"], "/.auth/api/v1", (c) => auth.handler(c.req.raw))
  app.on(["GET", "POST"], "/.auth/api/v1/*", (c) => auth.handler(c.req.raw))

  app.get("/.well-known/oauth-authorization-server", (c) =>
    oauthProviderAuthServerMetadata(auth)(c.req.raw),
  )

  app.get("/.well-known/openid-configuration", (c) =>
    oauthProviderOpenIdConfigMetadata(auth)(c.req.raw),
  )

  app.get("/.well-known/oauth-protected-resource/:orgSlug/mcp", async (c) => {
    const authorizationServer = c.var.env.AUTH_ISSUER ?? c.var.env.AUTH_BASE_URL
    const orgSlug = c.req.param("orgSlug")
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
