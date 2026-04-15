import type { OpenAPIHono } from "@hono/zod-openapi"
import type { Context } from "hono"
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose"
import type { AppEnv } from "../../../app/env.js"
import { parseAtlassianApiBaseUrlFromFitPayload } from "../../../lib/atlassian-api-base-url.js"
import {
  getForgeInstallationByCloudId,
  getPendingForgeInstallationByInstallerAccountId,
  updateForgeAppSystemTokenByInstallationId,
  upsertForgeInstallationFromEvent,
} from "../../../models/atlassian-connector.js"
import type { InstallationEvent } from "./atlassian-events.js"

const FORGE_ECOSYSTEM_INSTALLATION_ARI_PREFIX =
  "ari:cloud:ecosystem::installation/"
const ATLASSIAN_FORGE_REMOTE_JWKS_URL =
  "https://forge.cdn.prod.atlassian-dev.net/.well-known/jwks.json"

/** Strips leading `ari:cloud:ecosystem::installation/` when present; otherwise returns trimmed `raw`. */
function stripForgeEcosystemInstallationAriPrefix(
  installationIdWithPrefix: string,
): string {
  return installationIdWithPrefix
    .trim()
    .replace(FORGE_ECOSYSTEM_INSTALLATION_ARI_PREFIX, "")
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
}): Promise<ForgeInvocationTokenPayload> {
  const verified = await jwtVerify(
    input.token,
    getForgeJwks(ATLASSIAN_FORGE_REMOTE_JWKS_URL),
  )
  return verified.payload as ForgeInvocationTokenPayload
}

function getCloudIdFromContext(event: InstallationEvent): string | undefined {
  if (!event.context) return undefined
  // context format: ari:cloud:confluence::site/<cloudId>
  const parts = event.context.split("/")
  const cloudId = parts[parts.length - 1]
  return cloudId || undefined
}

function isForgeLifecycleEventType(
  t: string,
): t is InstallationEvent["eventType"] {
  return t === "avi:forge:installed:app" || t === "avi:forge:upgraded:app"
}

/** Explicit routing for Confluence product events (replace branches with per-event processors later). */
function isConfluenceHandledEventType(eventType: string): boolean {
  return (
    eventType === "avi:confluence:created:page" ||
    eventType === "avi:confluence:updated:page" ||
    eventType === "avi:confluence:deleted:page" ||
    eventType === "avi:confluence:updated:space:V2" ||
    eventType === "avi:confluence:deleted:space:V2"
  )
}

async function handleForgeLifecyclePost(
  c: Context<AppEnv>,
  fitPayload: ForgeInvocationTokenPayload,
  payload: InstallationEvent,
): Promise<Response> {
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

  const atlassianApiBaseUrl = parseAtlassianApiBaseUrlFromFitPayload(fitPayload)
  const appSystemToken = getSystemTokenFromHeaders(c)
  await upsertForgeInstallationFromEvent({
    orgId: installation.orgId,
    cloudId,
    status: "installed",
    installationContext: payload.context,
    installationId: payload.id,
    appId: payload.app.id,
    appSystemToken,
    atlassianApiBaseUrl,
    lastEventPayload: payload,
  })

  return c.body(null, 204)
}

export function registerAtlassianWebhookRoute(app: OpenAPIHono<AppEnv>) {
  app.post("/api/v1/webhook/atlassian/forge", async (c) => {
    const log = c.get("log")
    const invocationToken = getBearerToken(c.req.header("authorization"))
    if (!invocationToken) {
      return c.json({ error: "Missing Forge invocation token" }, 401)
    }

    let fitPayload: Awaited<ReturnType<typeof verifyForgeInvocationToken>>
    try {
      fitPayload = await verifyForgeInvocationToken({
        token: invocationToken,
      })
    } catch (e) {
      c.get("log").error(e instanceof Error ? e : new Error(String(e)), {
        step: "atlassian.verify_forge_invocation_token",
      })
      return c.json({ error: "Invalid Forge invocation token" }, 401)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400)
    }

    const eventType = (body as Record<string, unknown>).eventType
    if (typeof eventType !== "string") {
      return c.json({ error: "Missing eventType" }, 400)
    }

    if (isForgeLifecycleEventType(eventType)) {
      return handleForgeLifecyclePost(c, fitPayload, body as InstallationEvent)
    }

    if (isConfluenceHandledEventType(eventType)) {
      log.info("forge_confluence_webhook", { eventType })
      return c.body(null, 204)
    }

    log.warn("unhandled_forge_event_type", { eventType })
    return c.json({ error: "Unhandled event type", eventType }, 501)
  })

  app.post("/api/v1/webhook/atlassian/forge/token-refresh", async (c) => {
    const invocationToken = getBearerToken(c.req.header("authorization"))
    if (!invocationToken) {
      return c.json({ error: "Missing Forge invocation token" }, 401)
    }

    let fitPayload: Awaited<ReturnType<typeof verifyForgeInvocationToken>>
    try {
      fitPayload = await verifyForgeInvocationToken({
        token: invocationToken,
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
      return c.json(
        { error: "Missing or invalid installation id in token" },
        400,
      )
    }

    const atlassianApiBaseUrl =
      parseAtlassianApiBaseUrlFromFitPayload(fitPayload)
    const updated = await updateForgeAppSystemTokenByInstallationId({
      installationId: installationRecordId,
      appSystemToken,
      atlassianApiBaseUrl,
    })

    if (!updated) {
      return c.body(null, 202)
    }

    return c.body(null, 204)
  })
}
