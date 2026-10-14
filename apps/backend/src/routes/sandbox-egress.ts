import type { OpenAPIHono } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { AppEnv } from "../app/env.js"
import {
  INGEST_EGRESS_PATH,
  ingestEgressProxy,
} from "../domain/workspaces/ingest-egress-proxy.js"
import { vercelCredentials } from "../domain/workspaces/vercel-sandbox-provider.js"

/**
 * The egress proxy of hosted ingest sandboxes (see `ingestEgressProxy`). No
 * session auth: the Vercel OIDC token and the sealed scope authorize each
 * request. The OIDC audience is the public forward URL, so the request URL
 * gets the public origin (`AUTH_BASE_URL`) here: behind the platform's TLS
 * proxy, the server sees plain HTTP.
 */
export function registerSandboxEgressRoute(app: OpenAPIHono<AppEnv>) {
  const handle = (c: Context<AppEnv>) => {
    const request = c.req.raw
    const url = new URL(request.url)
    const publicUrl = `${new URL(c.var.env.AUTH_BASE_URL).origin}${url.pathname}${url.search}`
    return ingestEgressProxy({
      request: new Request(publicUrl, {
        method: request.method,
        headers: [...request.headers],
        ...(request.method === "GET" || request.method === "HEAD"
          ? {}
          : { body: request.body, duplex: "half" }),
      } as RequestInit),
      sealed: c.req.param("sealed") ?? "",
      secret: c.var.env.AUTH_SECRET,
      vercel: () => vercelCredentials(),
    })
  }
  app.all(`${INGEST_EGRESS_PATH}/:sealed`, handle)
  app.all(`${INGEST_EGRESS_PATH}/:sealed/*`, handle)
}
