import type { OpenAPIHono } from "@hono/zod-openapi"
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose"
import type { AppEnv } from "../../app/env.js"
import { parseAtlassianApiBaseUrlFromFitPayload } from "../../lib/atlassian-api-base-url.js"
import {
  getForgeInstallationByCloudId,
  getPendingForgeInstallationByInstallerAccountId,
  updateForgeAppSystemTokenByInstallationId,
  upsertForgeInstallationFromEvent,
} from "../../models/atlassian-connector.js"

const FORGE_ECOSYSTEM_INSTALLATION_ARI_PREFIX =
  "ari:cloud:ecosystem::installation/"

/** Strips leading `ari:cloud:ecosystem::installation/` when present; otherwise returns trimmed `raw`. */
function stripForgeEcosystemInstallationAriPrefix(installationIdWithPrefix: string): string {
  return installationIdWithPrefix.trim().replace(FORGE_ECOSYSTEM_INSTALLATION_ARI_PREFIX, "")
}

/**
 * Forge Invocation Token (FIT) — `app` object.
 * @see https://developer.atlassian.com/platform/forge/remote/essentials/#the-forge-invocation-token--fit-
 */
export type ForgeInvocationTokenApp = {
  installationId: string // example ari:cloud:ecosystem::installation/$id
  apiBaseUrl: string
  id: string
  /** @deprecated Internal; prefer `appVersion`. */
  version?: string
  appVersion: string
  environment: {
    type: string
    id: string
  }
  module: {
    type: string
    key: string
  }
  installation: {
    id: string
    contexts: Array<{
      name: string
      apiBaseUrl: string
    }>
  }
}

/** Verified FIT after `jwtVerify`; standard JWT claims vary. */
export type ForgeInvocationTokenPayload = JWTPayload & {
  app: ForgeInvocationTokenApp
}

/**
 * Bare installation id for `forge_installations.installation_id` from FIT `app.installationId`
 * (full ARI `ari:cloud:ecosystem::installation/<id>` or already-bare id). Exported for tests.
 */
export function parseInstallationIdFromFitPayload(
  fit: ForgeInvocationTokenPayload,
): string | undefined {
  const raw = fit.app.installationId
  if (!raw) return undefined
  return stripForgeEcosystemInstallationAriPrefix(raw)
}

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
  return c.req.header("x-forge-oauth-system")
}

async function verifyForgeInvocationToken(input: {
  token: string
  env: AppEnv["Variables"]["env"]
}): Promise<ForgeInvocationTokenPayload> {
  const jwksUrl =
    input.env.ATLASSIAN_FORGE_REMOTE_JWKS_URL ??
    "https://forge.cdn.prod.atlassian-dev.net/.well-known/jwks.json"
  const audience = input.env.ATLASSIAN_FORGE_REMOTE_AUDIENCE

  const verified = await jwtVerify(input.token, getForgeJwks(jwksUrl), {
    audience: audience || undefined,
  })
  return verified.payload as ForgeInvocationTokenPayload
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

    const atlassianApiBaseUrl =
      parseAtlassianApiBaseUrlFromFitPayload(fitPayload)
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

  app.post("/api/v1/webhook/atlassian/forge/token-refresh", async (c) => {
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

    const appSystemToken = getSystemTokenFromHeaders(c)
    if (!appSystemToken) {
      return c.json({ error: "Missing app system token" }, 400)
    }

    const installationRecordId = parseInstallationIdFromFitPayload(fitPayload)
    if (!installationRecordId) {
      return c.json({ error: "Missing or invalid installation id in token" }, 400)
    }

    const atlassianApiBaseUrl =
      parseAtlassianApiBaseUrlFromFitPayload(fitPayload)
    const updated = await updateForgeAppSystemTokenByInstallationId({
      installationId: installationRecordId,
      appSystemToken,
      atlassianApiBaseUrl
    })

    if (!updated) {
      return c.body(null, 202)
    }

    return c.body(null, 204)
  })
}
