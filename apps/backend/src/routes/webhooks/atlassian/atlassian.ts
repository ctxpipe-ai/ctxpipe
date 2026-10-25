import type { OpenAPIHono } from "@hono/zod-openapi"
import type { Context } from "hono"
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose"
import { z } from "zod"

import type { AppEnv } from "../../../app/env.js"
import type { Env } from "../../../config/env.js"
import { enqueueConnectionSourcesSync } from "../../../domain/workspace-sources/enqueue.js"
import { parseAtlassianApiBaseUrlFromFitPayload } from "../../../lib/atlassian-api-base-url.js"
import { forgeAppIdToAri } from "../../../lib/forge-app-manifest.js"
import {
  getForgeInstallationByForgeInstallationId,
  getPendingForgeInstallationByInstallerAccountId,
  patchForgeConnectionTypedConfig,
  upsertForgeInstallationFromEvent,
} from "../../../models/atlassian-connector.js"
import { getLogger } from "../../../observability/logger.js"
import { handleForgeConfluenceContentEvent } from "../../../services/confluence/forge-confluence-webhook.js"
import { CONFLUENCE_DELETED_PAGE_EVENT } from "../../../services/confluence/sync.js"
import type { ConfluenceSourceEvent } from "../../../services/confluence/workspace-source-adapter.js"
import { noteResolvedWebhookConnections } from "../attribution.js"
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
  /** Backend invocations of Confluence apps carry only `cloudId`. */
  context?: { cloudId?: string }
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

/**
 * Forge environment types that this deployment accepts. A Railway PR preview
 * and local development or tests also accept DEVELOPMENT and STAGING. All
 * other deployments, also an unknown one, accept only PRODUCTION.
 *
 * Off Railway, `NODE_ENV` of `development` or `test` counts as local. An unset
 * value parses as `development`. The published images set `production`.
 */
function acceptedForgeEnvironmentTypes(env: Env): string[] {
  const railway = env.RAILWAY_ENVIRONMENT_NAME?.trim()
  const preview = railway
    ? /^pr-\d+$/.test(railway)
    : env.NODE_ENV !== "production"
  return preview ? ["PRODUCTION", "DEVELOPMENT", "STAGING"] : ["PRODUCTION"]
}

/**
 * Checks the signature, the issuer, the age, and the Forge environment. The
 * caller must also check the app with {@link trustedForgeAppAri}.
 */
async function verifyForgeInvocationToken(
  token: string,
  env: Env,
): Promise<ForgeInvocationTokenPayload> {
  const verified = await jwtVerify(
    token,
    getForgeJwks(ATLASSIAN_FORGE_REMOTE_JWKS_URL),
    { issuer: "forge/invocation-token", maxTokenAge: "60s" },
  )
  const fit = verified.payload as ForgeInvocationTokenPayload
  if (!fit.app || typeof fit.app !== "object") {
    throw new Error("Forge invocation token has no app claim")
  }
  const environmentType = fit.app.environment?.type ?? ""
  if (!acceptedForgeEnvironmentTypes(env).includes(environmentType)) {
    throw new Error(
      `This deployment does not accept the Forge environment ${environmentType}`,
    )
  }
  return fit
}

/** App ARI from a Forge install URL (`/console/install/<app id>`). */
function forgeAppAriFromInstallUrl(
  url: string | null | undefined,
): string | null {
  const id = url?.match(/\/console\/install\/([0-9a-f-]{36})/i)?.[1]
  return forgeAppIdToAri(id)
}

/**
 * The app ARI when the Forge app of the call is the app of this connection:
 * the app that the connection saved, else the hosted ctxpipe app or the app of
 * a configured install URL. The audience and `app.id` must both name it.
 */
function trustedForgeAppAri(
  fit: ForgeInvocationTokenPayload,
  installation: {
    appId?: string | null
    confluenceForgeInstallUrl?: string | null
  },
  env: Env,
): string | undefined {
  const trusted = installation.appId
    ? [forgeAppIdToAri(installation.appId)]
    : [
        // The hosted app: `apps/forge-ctxpipe-agent/manifest.yml`.
        "ari:cloud:ecosystem::app/4ce198e3-2ce7-4a6e-865f-a3e31d15fe43",
        forgeAppAriFromInstallUrl(installation.confluenceForgeInstallUrl),
        forgeAppAriFromInstallUrl(env.CONFLUENCE_FORGE_INSTALL_URL),
      ]
  const audiences = Array.isArray(fit.aud) ? fit.aud : [fit.aud]
  const app = fit.app.id
  return audiences.includes(app) && trusted.includes(app) ? app : undefined
}

/**
 * Site cloud id from the checked `app.apiBaseUrl`. `null` when the
 * `context.cloudId` claim names another site.
 */
function getCloudIdFromFit(
  fit: ForgeInvocationTokenPayload,
): string | undefined | null {
  const cloudId = parseAtlassianApiBaseUrlFromFitPayload(fit)?.split("/").at(-1)
  if (!cloudId) return undefined
  const fromContext = fit.context?.cloudId
  if (fromContext != null && fromContext !== cloudId) return null
  return cloudId
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
    eventType === "avi:confluence:moved:page" ||
    eventType === CONFLUENCE_DELETED_PAGE_EVENT ||
    eventType === "avi:confluence:created:attachment" ||
    eventType === "avi:confluence:updated:attachment" ||
    eventType === "avi:confluence:archived:attachment" ||
    eventType === "avi:confluence:unarchived:attachment" ||
    eventType === "avi:confluence:trashed:attachment" ||
    eventType === "avi:confluence:restored:attachment" ||
    eventType === "avi:confluence:deleted:attachment" ||
    eventType === "avi:confluence:updated:space:V2" ||
    eventType === "avi:confluence:deleted:space:V2"
  )
}

async function handleForgeLifecyclePost(
  c: Context<AppEnv>,
  fitPayload: ForgeInvocationTokenPayload,
  payload: InstallationEvent,
): Promise<Response> {
  const log = getLogger()
  // The installation and the site come from the signed claims. The body must agree.
  const installationId = parseInstallationIdFromFitPayload(fitPayload)
  const cloudId = getCloudIdFromFit(fitPayload)
  if (!installationId || !cloudId) {
    return c.json(
      {
        error:
          "The Forge invocation token has no installation or site, or names two sites",
      },
      400,
    )
  }
  const bodyCloudId = getCloudIdFromContext(payload)
  if (
    (payload.id &&
      stripForgeEcosystemInstallationAriPrefix(payload.id) !==
        installationId) ||
    (bodyCloudId && bodyCloudId !== cloudId)
  ) {
    return c.json(
      {
        error:
          "The lifecycle payload does not match the Forge invocation token",
      },
      400,
    )
  }

  const env = c.get("env")
  // The signed installation comes first. The body installer account finds
  // only a new setup, and only when that setup trusts the app of the call.
  const installed =
    await getForgeInstallationByForgeInstallationId(installationId)
  let installation = installed
  if (!installed && payload.installerAccountId) {
    const pending = await getPendingForgeInstallationByInstallerAccountId(
      payload.installerAccountId,
    )
    if (pending && trustedForgeAppAri(fitPayload, pending, env)) {
      installation = pending
    } else if (pending) {
      log.warn("forge_lifecycle_untrusted_app", {
        connectionId: pending.id,
        orgId: pending.orgId,
      })
    }
  }

  if (!installation) {
    // Accept and no-op to keep retries from spamming when org mapping does not exist yet.
    return c.body(null, 202)
  }

  noteResolvedWebhookConnections([installation])

  const appId = trustedForgeAppAri(fitPayload, installation, env)
  if (!appId) {
    log.warn("forge_lifecycle_untrusted_app", {
      connectionId: installation.id,
      orgId: installation.orgId,
    })
    return c.json({ error: "Invalid Forge invocation token" }, 401)
  }

  if (installation.cloudId != null && installation.cloudId !== cloudId) {
    log.warn("forge_lifecycle_cloud_id_mismatch", {
      connectionId: installation.id,
      orgId: installation.orgId,
      eventCloudId: cloudId,
      rowCloudId: installation.cloudId,
    })
    return c.body(null, 202)
  }

  const atlassianApiBaseUrl = parseAtlassianApiBaseUrlFromFitPayload(fitPayload)
  const appSystemToken = getSystemTokenFromHeaders(c)
  await upsertForgeInstallationFromEvent({
    orgId: installation.orgId,
    connectionId: installation.id,
    cloudId,
    status: "installed",
    installationContext: `ari:cloud:confluence::site/${cloudId}`,
    installationId,
    appId,
    appSystemToken,
    atlassianApiBaseUrl,
    lastEventPayload: payload,
  })

  return c.body(null, 204)
}

export function registerAtlassianWebhookRoute(app: OpenAPIHono<AppEnv>) {
  app.post("/api/v1/webhook/atlassian/forge", async (c) => {
    const log = getLogger()
    const invocationToken = getBearerToken(c.req.header("authorization"))
    if (!invocationToken) {
      return c.json({ error: "Missing Forge invocation token" }, 401)
    }

    let fitPayload: Awaited<ReturnType<typeof verifyForgeInvocationToken>>
    try {
      fitPayload = await verifyForgeInvocationToken(
        invocationToken,
        c.get("env"),
      )
    } catch (e) {
      getLogger().error(e instanceof Error ? e : new Error(String(e)), {
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

    const envelope = z
      .object({ eventType: z.string().min(1) })
      .passthrough()
      .safeParse(body)
    if (!envelope.success) {
      return c.json({ error: "Missing eventType" }, 400)
    }
    const { eventType } = envelope.data

    if (isForgeLifecycleEventType(eventType)) {
      return handleForgeLifecyclePost(c, fitPayload, body as InstallationEvent)
    }

    if (isConfluenceHandledEventType(eventType)) {
      const spaceSchema = z
        .object({ key: z.string().min(1).optional() })
        .passthrough()
      const payloadResult = z
        .object({
          eventType: z.string(),
          content: z
            .object({
              id: z.string().min(1).optional(),
              space: spaceSchema.optional(),
            })
            .passthrough()
            .optional(),
          prevContent: z
            .object({ space: spaceSchema.optional() })
            .passthrough()
            .optional(),
          attachment: z
            .object({
              space: spaceSchema.optional(),
              container: z
                .object({
                  id: z.string().min(1).optional(),
                  type: z.string().min(1).optional(),
                  space: spaceSchema.optional(),
                })
                .passthrough()
                .optional(),
            })
            .passthrough()
            .optional(),
          space: spaceSchema.optional(),
        })
        .passthrough()
        .safeParse(body)
      if (!payloadResult.success) {
        return c.json({ error: "Invalid Confluence event payload" }, 400)
      }
      const payload = payloadResult.data
      const cloudIdFromFit = getCloudIdFromFit(fitPayload)
      if (cloudIdFromFit === null) {
        return c.json(
          { error: "The Forge invocation token names two sites" },
          400,
        )
      }
      if (!cloudIdFromFit) {
        log.warn("forge_confluence_webhook_missing_cloud_id", { eventType })
        return c.body(null, 202)
      }
      const forgeInstallationId = parseInstallationIdFromFitPayload(fitPayload)
      if (!forgeInstallationId) {
        log.warn("forge_confluence_webhook_missing_installation_id", {
          eventType,
        })
        return c.body(null, 202)
      }
      const installation =
        await getForgeInstallationByForgeInstallationId(forgeInstallationId)
      if (!installation) {
        log.warn("forge_confluence_webhook_unmapped_installation", {
          eventType,
          forgeInstallationId,
        })
        return c.body(null, 202)
      }
      noteResolvedWebhookConnections([installation])
      if (!trustedForgeAppAri(fitPayload, installation, c.get("env"))) {
        log.warn("forge_confluence_webhook_untrusted_app", {
          eventType,
          connectionId: installation.id,
          orgId: installation.orgId,
        })
        return c.json({ error: "Invalid Forge invocation token" }, 401)
      }
      if (
        installation.cloudId != null &&
        installation.cloudId !== cloudIdFromFit
      ) {
        log.warn("forge_confluence_webhook_cloud_id_mismatch", {
          eventType,
          connectionId: installation.id,
          orgId: installation.orgId,
          fitCloudId: cloudIdFromFit,
          rowCloudId: installation.cloudId,
        })
        return c.body(null, 202)
      }
      const content = payload.content
      const previousContent = payload.prevContent
      const attachment = payload.attachment
      const space = payload.space
      if (
        eventType.endsWith(":attachment") &&
        attachment?.container?.type !== "page"
      ) {
        log.info("forge_confluence_webhook_unsupported_attachment_container", {
          eventType,
          containerType: attachment?.container?.type,
        })
        return c.body(null, 202)
      }

      const primarySpaceKey =
        content?.space?.key ??
        attachment?.space?.key ??
        attachment?.container?.space?.key ??
        space?.key
      const targetBySpace = new Map<
        string,
        { spaceKey: string; pageId?: string }
      >()
      if (primarySpaceKey) {
        targetBySpace.set(primarySpaceKey, {
          spaceKey: primarySpaceKey,
          pageId:
            eventType === "avi:confluence:moved:page"
              ? undefined
              : (content?.id ?? attachment?.container?.id),
        })
      }
      if (eventType === "avi:confluence:moved:page") {
        const previousSpaceKey = previousContent?.space?.key
        if (previousSpaceKey) {
          targetBySpace.set(previousSpaceKey, {
            spaceKey: previousSpaceKey,
            pageId: undefined,
          })
        }
      }
      const targets = [...targetBySpace.values()]
      if (targets.length === 0) {
        log.warn("forge_confluence_webhook_missing_space_key", { eventType })
        return c.body(null, 202)
      }
      // ADR-050: Workspace sources sync once for each connection.
      try {
        await enqueueConnectionSourcesSync({
          orgId: installation.orgId,
          connectionId: installation.id,
          provider: "confluence",
          event: {
            spaceKeys: targets.map((target) => target.spaceKey),
            pageId: targets[0]?.pageId,
            eventType,
          } satisfies ConfluenceSourceEvent,
        })
      } catch (error) {
        log.error("forge_confluence_webhook_sources_enqueue_failed", {
          eventType,
          connectionId: installation.id,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      let enqueued = false
      let reset = false
      for (const target of targets) {
        const outcome = await handleForgeConfluenceContentEvent({
          orgId: installation.orgId,
          connectionId: installation.id,
          env: c.get("env"),
          spaceKey: target.spaceKey,
          pageId: target.pageId,
          eventType,
        })
        if (outcome === "skipped") {
          log.info("forge_confluence_webhook_skipped", {
            eventType,
            orgId: installation.orgId,
            spaceKey: target.spaceKey,
            pageId: target.pageId,
          })
          continue
        }
        if (outcome === "reset") {
          reset = true
          log.warn("forge_confluence_webhook_reset_missing_git_config", {
            eventType,
            orgId: installation.orgId,
            connectionId: installation.id,
          })
          continue
        }
        enqueued = true
        log.info("forge_confluence_webhook_enqueued", {
          eventType,
          orgId: installation.orgId,
          spaceKey: target.spaceKey,
          pageId: target.pageId,
        })
      }
      return c.body(null, enqueued || reset ? 204 : 202)
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
      fitPayload = await verifyForgeInvocationToken(
        invocationToken,
        c.get("env"),
      )
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

    const installation =
      await getForgeInstallationByForgeInstallationId(installationRecordId)
    if (!installation) {
      return c.body(null, 202)
    }
    if (!trustedForgeAppAri(fitPayload, installation, c.get("env"))) {
      getLogger().warn("forge_token_refresh_untrusted_app", {
        connectionId: installation.id,
        orgId: installation.orgId,
      })
      return c.json({ error: "Invalid Forge invocation token" }, 401)
    }

    const atlassianApiBaseUrl =
      parseAtlassianApiBaseUrlFromFitPayload(fitPayload)
    const updated = await patchForgeConnectionTypedConfig(
      installation.orgId,
      installation.id,
      {
        appSystemToken,
        ...(atlassianApiBaseUrl ? { atlassianApiBaseUrl } : {}),
      },
    )
    return c.body(null, updated ? 204 : 202)
  })
}
