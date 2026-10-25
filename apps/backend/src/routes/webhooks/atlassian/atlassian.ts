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
  updateForgeAppSystemTokenByInstallationId,
  upsertForgeInstallationFromEvent,
} from "../../../models/atlassian-connector.js"
import { getLogger } from "../../../observability/logger.js"
import { otelDeploymentEnvironment } from "../../../observability/otel.js"
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
 * Checks the signature, the issuer, and the Forge environment. A production
 * deployment accepts only the production Forge environment. The caller must
 * also check the audience with {@link isTrustedForgeApp}.
 */
async function verifyForgeInvocationToken(input: {
  token: string
}): Promise<ForgeInvocationTokenPayload> {
  const verified = await jwtVerify(
    input.token,
    getForgeJwks(ATLASSIAN_FORGE_REMOTE_JWKS_URL),
    { issuer: "forge/invocation-token" },
  )
  const fit = verified.payload as ForgeInvocationTokenPayload
  if (!fit.app || typeof fit.app !== "object") {
    throw new Error("Forge invocation token has no app claim")
  }
  if (
    otelDeploymentEnvironment() === "production" &&
    fit.app.environment?.type !== "PRODUCTION"
  ) {
    throw new Error(
      "Forge invocation token is not from a production environment",
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
 * True when the token audience is the Forge app of this connection: the app
 * that the connection saved, else the hosted ctxpipe app or the app of a
 * configured install URL.
 */
function isTrustedForgeApp(
  fit: ForgeInvocationTokenPayload,
  installation: {
    appId?: string | null
    confluenceForgeInstallUrl?: string | null
  },
  env: Env,
): boolean {
  const trusted = installation.appId
    ? [forgeAppIdToAri(installation.appId)]
    : [
        // The hosted app: `apps/forge-ctxpipe-agent/manifest.yml`.
        "ari:cloud:ecosystem::app/4ce198e3-2ce7-4a6e-865f-a3e31d15fe43",
        forgeAppAriFromInstallUrl(installation.confluenceForgeInstallUrl),
        forgeAppAriFromInstallUrl(env.CONFLUENCE_FORGE_INSTALL_URL),
      ]
  const audiences = Array.isArray(fit.aud) ? fit.aud : [fit.aud]
  return audiences.some((aud) => aud != null && trusted.includes(aud))
}

/** Site cloud id from the signed claims. */
function getCloudIdFromFit(
  fit: ForgeInvocationTokenPayload,
): string | undefined {
  const fromContext = fit.context?.cloudId
  if (typeof fromContext === "string" && fromContext) return fromContext
  return fit.app.apiBaseUrl?.split("/").at(-1) || undefined
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
      { error: "The Forge invocation token has no installation or site" },
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

  const installation =
    (payload.installerAccountId
      ? await getPendingForgeInstallationByInstallerAccountId(
          payload.installerAccountId,
        )
      : undefined) ??
    (await getForgeInstallationByForgeInstallationId(installationId))

  if (!installation) {
    // Accept and no-op to keep retries from spamming when org mapping does not exist yet.
    return c.body(null, 202)
  }

  noteResolvedWebhookConnections([installation])

  if (!isTrustedForgeApp(fitPayload, installation, c.get("env"))) {
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
    appId: Array.isArray(fitPayload.aud) ? fitPayload.aud[0] : fitPayload.aud,
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
      fitPayload = await verifyForgeInvocationToken({
        token: invocationToken,
      })
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
      if (!isTrustedForgeApp(fitPayload, installation, c.get("env"))) {
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

    const installation =
      await getForgeInstallationByForgeInstallationId(installationRecordId)
    if (!installation) {
      return c.body(null, 202)
    }
    if (!isTrustedForgeApp(fitPayload, installation, c.get("env"))) {
      return c.json({ error: "Invalid Forge invocation token" }, 401)
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
