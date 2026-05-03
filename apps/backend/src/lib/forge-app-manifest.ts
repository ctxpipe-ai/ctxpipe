/**
 * Forge `manifest.yml` for the CtxPipe Confluence/Remote app. The worker only writes
 * this file (plus a minimal `package.json`); it does not copy `apps/forge-ctxpipe-agent`.
 * `remotes.baseUrl` is a **literal** public API origin (no `environment` placeholder).
 *
 * **Keep in sync** with the reference `apps/forge-ctxpipe-agent/manifest.yml` (used for
 * `forge lint` / operator deploys) on modules, scopes, and remote keys—reference may
 * still use `${REMOTE_BASE_URL}` for local/CI. If you add scopes or remotes, update both.
 */
import { stringify } from "yaml"

export type BuildForgeAppManifestInput = {
  /**
   * Full `ari:cloud:ecosystem::app/...` when redeploying an existing app; omit for
   * first `forge register` (manifest has no `app.id` line until Atlassian assigns one).
   */
  appIdAri: string | null
  /**
   * Public API origin the Forge app should call (no trailing slash), e.g. from
   * `CTXPIPE_PUBLIC_APP_URL` or `AUTH_BASE_URL`. Injected as `remotes[0].baseUrl`.
   */
  remoteBaseUrl: string
}

const LIFECYCLE_EVENTS = [
  "avi:forge:installed:app",
  "avi:forge:upgraded:app",
  "avi:confluence:created:page",
  "avi:confluence:updated:page",
  "avi:confluence:deleted:page",
  "avi:confluence:updated:space:V2",
  "avi:confluence:deleted:space:V2",
] as const

const PERMISSION_SCOPES = [
  "read:app-system-token",
  "read:space:confluence",
  "read:page:confluence",
  "read:confluence-content.summary",
  "write:confluence-content",
  "read:confluence-space.summary",
  "write:confluence-space",
] as const

function buildManifestDocument(appIdAri: string | null, remoteBaseUrl: string) {
  const app: {
    runtime: { name: string; memoryMB: number; architecture: string }
    id?: string
  } = {
    runtime: {
      name: "nodejs24.x",
      memoryMB: 256,
      architecture: "arm64",
    },
  }
  if (appIdAri != null && appIdAri.length > 0) {
    app.id = appIdAri
  }

  return {
    modules: {
      trigger: [
        {
          key: "ctxpipe-remote-forge-lifecycle",
          endpoint: "ctxpipe-remote-events",
          events: [...LIFECYCLE_EVENTS],
        },
      ],
      scheduledTrigger: [
        {
          key: "ctxpipe-scheduled-token-refresh",
          endpoint: "ctxpipe-token-refresh",
          interval: "hour",
        },
      ],
      endpoint: [
        {
          key: "ctxpipe-remote-events",
          remote: "ctxpipe-backend",
          route: { path: "/api/v1/webhook/atlassian/forge" },
          auth: { appSystemToken: { enabled: true } },
        },
        {
          key: "ctxpipe-token-refresh",
          remote: "ctxpipe-backend",
          route: { path: "/api/v1/webhook/atlassian/forge/token-refresh" },
          auth: { appSystemToken: { enabled: true } },
        },
      ],
    },
    app,
    remotes: [
      {
        key: "ctxpipe-backend",
        baseUrl: remoteBaseUrl,
      },
    ],
    permissions: {
      scopes: [...PERMISSION_SCOPES],
    },
  }
}

function normalizePublicOrigin(u: string): string {
  return u.trim().replace(/\/$/, "")
}

export function buildForgeAppManifestYml(
  input: BuildForgeAppManifestInput,
): string {
  const base = normalizePublicOrigin(input.remoteBaseUrl)
  if (!base) {
    throw new Error("buildForgeAppManifestYml: remoteBaseUrl is required")
  }
  return stringify(buildManifestDocument(input.appIdAri, base), {
    lineWidth: 0,
  })
}

/**
 * Normalize `appId` from `connections.config` to a full `app` ARI when present.
 */
export function forgeAppIdToAri(
  appId: string | null | undefined,
): string | null {
  if (appId == null || !String(appId).trim()) return null
  const t = String(appId).trim()
  if (t.startsWith("ari:")) return t
  return `ari:cloud:ecosystem::app/${t.replace(/^app\//, "")}`
}
