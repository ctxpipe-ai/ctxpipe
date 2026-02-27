import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider"
import type { Hono } from "hono"
import type { AppEnv } from "../app/env.js"
import { getAuth } from "../auth/config.js"

export function registerAuthRoutes(app: Hono<AppEnv>) {
  const auth = getAuth()
  app.on(["GET", "POST"], "/.auth/*", (c) => auth.handler(c.req.raw))

  app.get("/.well-known/oauth-authorization-server/api/auth", (c) =>
    oauthProviderAuthServerMetadata(auth)(c.req.raw),
  )

  app.get("/.well-known/openid-configuration", (c) =>
    oauthProviderOpenIdConfigMetadata(auth)(c.req.raw),
  )
  return app
}
