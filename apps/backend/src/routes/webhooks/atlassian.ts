import type { OpenAPIHono } from "@hono/zod-openapi"
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose"
import type { AppEnv } from "../../app/env.js"
import { parseAtlassianApiBaseUrlFromFitPayload } from "../../lib/atlassian-api-base-url.js"
import {
  getForgeInstallationByCloudId,
  getPendingForgeInstallationByInstallerAccountId,
  upsertForgeInstallationFromEvent,
} from "../../models/atlassian-connector.js"

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined
let cachedJwksUrl: string | undefined

function getForgeJwks(url: string) {
  if (!cachedJwks || cachedJwksUrl !== url) {
    cachedJwks = createRemoteJWKSet(new URL(url))
    cachedJwksUrl = url
  }
  return cachedJwks
}

function getBearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (!value.toLowerCase().startsWith("bearer ")) return undefined
  return value.slice("bearer ".length).trim()
}

function getSystemTokenFromHeaders(c: {
  req: { header: (name: string) => string | undefined }
}) {
  const raw = c.req.header("x-forge-oauth-system")
  if (!raw) return undefined
  const bearer = getBearerToken(raw)
  return bearer ?? raw
}

async function verifyForgeInvocationToken(input: {
  token: string
  env: AppEnv["Variables"]["env"]
}): Promise<JWTPayload> {
  const jwksUrl =
    input.env.ATLASSIAN_FORGE_REMOTE_JWKS_URL ??
    "https://forge.cdn.prod.atlassian-dev.net/.well-known/jwks.json"
  const audience = input.env.ATLASSIAN_FORGE_REMOTE_AUDIENCE

  const verified = await jwtVerify(input.token, getForgeJwks(jwksUrl), {
    audience: audience || undefined,
  })
  return verified.payload
}

function getCloudIdFromContext(event: InstallationEvent): string | undefined {
  if (!event.context) return undefined
  // context format: ari:cloud:confluence::site/<cloudId>
  const parts = event.context.split("/")
  const cloudId = parts[parts.length - 1]
  return cloudId || undefined
}

type InstallationEvent = {
  id: string
  context: string // ari:cloud:confluence::site/cloudId
  installerAccountId: string
  app: {
    id: string
    version: string
    name?: string
    ownerAccountId?: string
  }
  eventType: "avi:forge:installed:app" | "avi:forge:upgraded:app" | "avi:forge:uninstalled:app"
  environment: {
    id: string
  }
}

export function registerAtlassianWebhookRoute(app: OpenAPIHono<AppEnv>) {
  app.post("/api/v1/webhook/atlassian/forge", async (c) => {
    const env = c.get("env")
    const invocationToken = getBearerToken(c.req.header("authorization"))
    if (!invocationToken) {
      return c.json({ error: "Missing Forge invocation token" }, 401)
    }

    let fitPayload: Awaited<ReturnType<typeof verifyForgeInvocationToken>>
    try {
      fitPayload = await verifyForgeInvocationToken({
        token: invocationToken,
        env,
      })
    } catch {
      return c.json({ error: "Invalid Forge invocation token" }, 401)
    }

    const atlassianApiBaseUrl =
      parseAtlassianApiBaseUrlFromFitPayload(fitPayload)

    let payload: InstallationEvent | null
    try {
      payload = (await c.req.json()) as InstallationEvent
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400)
    }

    const cloudId = getCloudIdFromContext(payload)
    if (!cloudId) {
      return c.json({ error: "Missing cloudId in lifecycle payload" }, 400)
    }

    let installation = await getForgeInstallationByCloudId(cloudId)
    if (!installation) {
      if (!payload?.installerAccountId) {
        return c.body(null, 202)
      }
      installation = await getPendingForgeInstallationByInstallerAccountId(
        payload.installerAccountId,
      )
      if (!installation) {
        // Accept and no-op to keep retries from spamming when org mapping does not exist yet.
        return c.body(null, 202)
      }
    }

    const appSystemToken = getSystemTokenFromHeaders(c)
    await upsertForgeInstallationFromEvent({
      orgId: installation.orgId,
      cloudId,
      status: payload.eventType === "avi:forge:uninstalled:app" ? "uninstalled" : "installed",
      installationContext: payload.context,
      installationId: payload.id,
      appId: payload.app.id,
      appSystemToken,
      atlassianApiBaseUrl,
      lastEventPayload: payload,
    })

    return c.body(null, 204)
  })
}
