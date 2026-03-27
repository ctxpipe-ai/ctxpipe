import type { OpenAPIHono } from "@hono/zod-openapi"
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose"
import type { AppEnv } from "../../app/env.js"
import {
  getAtlassianInstanceByCloudId,
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

function getSystemTokenFromHeaders(c: { req: { header: (name: string) => string | undefined } }) {
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

function tryExtractCloudId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined
  const record = body as Record<string, unknown>

  const direct = record.cloudId
  if (typeof direct === "string" && direct.length > 0) return direct

  const payload = record.payload
  if (payload && typeof payload === "object") {
    const payloadRecord = payload as Record<string, unknown>
    const payloadCloudId = payloadRecord.cloudId
    if (typeof payloadCloudId === "string" && payloadCloudId.length > 0) {
      return payloadCloudId
    }

    const installation = payloadRecord.installation
    if (installation && typeof installation === "object") {
      const installationRecord = installation as Record<string, unknown>
      const cloudId = installationRecord.cloudId
      if (typeof cloudId === "string" && cloudId.length > 0) return cloudId
    }
  }

  return undefined
}

function tryExtractSiteUrl(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined
  const record = body as Record<string, unknown>
  const direct = record.siteUrl
  if (typeof direct === "string" && direct.length > 0) return direct

  const payload = record.payload
  if (!payload || typeof payload !== "object") return undefined
  const payloadRecord = payload as Record<string, unknown>
  const baseUrl = payloadRecord.baseUrl
  if (typeof baseUrl === "string" && baseUrl.length > 0) return baseUrl
  const siteUrl = payloadRecord.siteUrl
  if (typeof siteUrl === "string" && siteUrl.length > 0) return siteUrl
  return undefined
}

function tryExtractInstallationFields(body: unknown): {
  status: string
  installationContext?: string
  installationId?: string
  appId?: string
} {
  if (!body || typeof body !== "object") {
    return { status: "installed" }
  }
  const record = body as Record<string, unknown>
  const eventType =
    typeof record.eventType === "string"
      ? record.eventType
      : typeof record.event === "string"
        ? record.event
        : "installed"

  const payload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : undefined
  const installation =
    payload?.installation && typeof payload.installation === "object"
      ? (payload.installation as Record<string, unknown>)
      : undefined

  const installationContext =
    (typeof installation?.installationContext === "string"
      ? installation.installationContext
      : undefined) ??
    (typeof payload?.installationContext === "string"
      ? payload.installationContext
      : undefined)

  const installationId =
    (typeof installation?.id === "string" ? installation.id : undefined) ??
    (typeof installation?.id === "number" ? String(installation.id) : undefined)

  const appId =
    (typeof record.appId === "string" ? record.appId : undefined) ??
    (typeof payload?.appId === "string" ? payload.appId : undefined)

  return {
    status: eventType.toLowerCase().includes("uninstall")
      ? "uninstalled"
      : "installed",
    installationContext,
    installationId,
    appId,
  }
}

export function registerAtlassianWebhookRoute(app: OpenAPIHono<AppEnv>) {
  app.post("/api/v1/webhook/atlassian/forge", async (c) => {
    const env = c.get("env")
    const invocationToken = getBearerToken(c.req.header("authorization"))
    if (!invocationToken) {
      return c.json({ error: "Missing Forge invocation token" }, 401)
    }

    try {
      await verifyForgeInvocationToken({ token: invocationToken, env })
    } catch {
      return c.json({ error: "Invalid Forge invocation token" }, 401)
    }

    let payload: unknown
    try {
      payload = (await c.req.json()) as unknown
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400)
    }

    const cloudId = tryExtractCloudId(payload)
    if (!cloudId) {
      return c.json({ error: "Missing cloudId in lifecycle payload" }, 400)
    }

    const instance = await getAtlassianInstanceByCloudId(cloudId)
    if (!instance) {
      // Accept and no-op to keep retries from spamming when org mapping does not exist yet.
      return c.body(null, 202)
    }

    const fields = tryExtractInstallationFields(payload)
    const appSystemToken = getSystemTokenFromHeaders(c)
    await upsertForgeInstallationFromEvent({
      orgId: instance.orgId,
      cloudId,
      status: fields.status,
      installationContext: fields.installationContext,
      installationId: fields.installationId,
      appId: fields.appId,
      appSystemToken,
      lastEventPayload: payload,
    })

    // Keep for future diagnostics and parity with Atlassian payload variants.
    void tryExtractSiteUrl(payload)

    return c.body(null, 204)
  })
}
