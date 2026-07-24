import type { QueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { githubConnectorKeys } from "@/features/connectors/queries/github-connector"
import { orgConnectionsKeys } from "@/features/connectors/queries/org-connections"
import { client } from "@/lib/api"

/**
 * Shared key for the GitHub setup popup to relay `installation_id` back to the
 * opener via localStorage. The popup writes, the opener reads + deletes.
 */
export const GITHUB_SETUP_RESULT_KEY = "github-setup-result"
export const GITHUB_SETUP_ORG_HINT_KEY = "github-setup-org-hint"
export const NOTION_SETUP_RESULT_KEY = "notion-setup-result"
/** Draft `con_*` id for wizard: popup callback merges install with this row. */
export const GITHUB_DRAFT_CONNECTION_KEY = "github-draft-connection-id"
export const GITHUB_POPUP_FLOW_KEY = "github-popup-flow"

const GITHUB_POPUP_FLOW_TTL_MS = 15 * 60 * 1000

type GithubPopupFlowState = {
  nonce: string
  startedAtMs: number
}

export type GithubSetupRegistrationStatus =
  | "no_result"
  | "registered"
  | "registration_failed"

export type NotionSetupPopupResult =
  | { status: "no_result" }
  | { status: "connected"; connectionId: string }
  | { status: "error"; error: string }

/** Window name used when opening the GitHub app install popup. */
export const GITHUB_POPUP_NAME = "github-app-install"
export const NOTION_POPUP_NAME = "ctxpipe-notion-connect"

function safeNowMs() {
  return Date.now()
}

function parsePopupFlowState(raw: string | null): GithubPopupFlowState | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<GithubPopupFlowState>
    if (
      typeof parsed.nonce !== "string" ||
      parsed.nonce.length === 0 ||
      typeof parsed.startedAtMs !== "number"
    ) {
      return null
    }
    if (safeNowMs() - parsed.startedAtMs > GITHUB_POPUP_FLOW_TTL_MS) return null
    return { nonce: parsed.nonce, startedAtMs: parsed.startedAtMs }
  } catch {
    return null
  }
}

function createPopupFlowNonce() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID()
  }
  return `${safeNowMs()}-${Math.random().toString(36).slice(2)}`
}

export function beginGithubPopupFlow() {
  if (typeof window === "undefined") return null
  const state: GithubPopupFlowState = {
    nonce: createPopupFlowNonce(),
    startedAtMs: safeNowMs(),
  }
  localStorage.setItem(GITHUB_POPUP_FLOW_KEY, JSON.stringify(state))
  return state.nonce
}

export function getActiveGithubPopupFlowState() {
  if (typeof window === "undefined") return null
  const parsed = parsePopupFlowState(
    localStorage.getItem(GITHUB_POPUP_FLOW_KEY),
  )
  if (!parsed) localStorage.removeItem(GITHUB_POPUP_FLOW_KEY)
  return parsed
}

export function clearGithubPopupFlow() {
  if (typeof window === "undefined") return
  localStorage.removeItem(GITHUB_POPUP_FLOW_KEY)
}

/**
 * Persist the org context before opening the GitHub install flow so direct
 * callback navigation can resolve the intended org without guessing.
 */
export function setGithubSetupOrgHint(orgSlug: string) {
  if (typeof window === "undefined" || !orgSlug) return
  localStorage.setItem(GITHUB_SETUP_ORG_HINT_KEY, orgSlug)
}

/**
 * Consume the stored org hint once on callback handling. The hint is
 * intentionally short-lived to avoid stale org selection.
 */
export function consumeGithubSetupOrgHint() {
  if (typeof window === "undefined") return null
  const orgSlug = localStorage.getItem(GITHUB_SETUP_ORG_HINT_KEY)
  localStorage.removeItem(GITHUB_SETUP_ORG_HINT_KEY)
  return orgSlug
}

export function peekGithubDraftConnectionHint(): string | null {
  if (typeof window === "undefined") return null
  return localStorage.getItem(GITHUB_DRAFT_CONNECTION_KEY)
}

type PopupOptions = {
  name?: string
  width?: number
  height?: number
}

export function openCenteredPopup(url: string, options?: PopupOptions) {
  if (typeof window === "undefined") return null

  const width = options?.width ?? 1100
  const height = options?.height ?? 760
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2)
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2)

  const popup = window.open(
    url,
    options?.name ?? "github-connect",
    [
      "popup=yes",
      `width=${Math.floor(width)}`,
      `height=${Math.floor(height)}`,
      `left=${Math.floor(left)}`,
      `top=${Math.floor(top)}`,
      "resizable=yes",
      "scrollbars=yes",
    ].join(","),
  )

  if (!popup) {
    window.location.assign(url)
    return null
  }

  popup.focus()
  return popup
}

/**
 * Polls until `popup` is closed, then runs `onClosed`. Returns a disposer that clears the interval.
 * Prefer {@link useWatchPopupClose} in components so cleanup runs on unmount and when opening a new popup.
 */
export function onPopupClosed(popup: Window, onClosed: () => void) {
  if (typeof window === "undefined") return () => {}

  const timer = window.setInterval(() => {
    if (!popup.closed) return
    window.clearInterval(timer)
    onClosed()
  }, 400)

  return () => window.clearInterval(timer)
}

/** Registers a popup close watcher; clears any prior watcher on unmount or on the next register call. */
export function useWatchPopupClose() {
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [])

  return (popup: Window, onClosed: () => void) => {
    cleanupRef.current?.()
    cleanupRef.current = onPopupClosed(popup, onClosed)
  }
}

/**
 * Reads the GitHub setup result from localStorage (written by the popup),
 * POSTs the installation registration, and invalidates the relevant query.
 */
export async function handleGithubSetupPopupResult(
  orgSlug: string,
  queryClient: QueryClient,
): Promise<{ status: GithubSetupRegistrationStatus }> {
  const raw = localStorage.getItem(GITHUB_SETUP_RESULT_KEY)
  localStorage.removeItem(GITHUB_SETUP_RESULT_KEY)
  const activePopupFlow = getActiveGithubPopupFlowState()

  let status: GithubSetupRegistrationStatus = "no_result"

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as {
        installationId: number
        connectionId?: string
        popupFlowNonce?: string
      }
      const { installationId, connectionId, popupFlowNonce } = parsed
      const nonceMatches =
        !activePopupFlow ||
        (typeof popupFlowNonce === "string" &&
          popupFlowNonce.length > 0 &&
          popupFlowNonce === activePopupFlow.nonce)
      if (installationId && orgSlug) {
        if (nonceMatches) {
          const response = await client[
            ":orgSlug"
          ].api.v1.github.installation.$post({
            param: { orgSlug },
            json: {
              installationId,
              ...(connectionId ? { connectionId } : {}),
            },
          })
          status = response.ok ? "registered" : "registration_failed"
        }
      }
    } catch {
      // Registration may fail — query invalidation below will reflect
      // current server state.
      status = "registration_failed"
    }
  }

  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: githubConnectorKeys.allInstallationForOrg(orgSlug),
      refetchType: "active",
    }),
    queryClient.invalidateQueries({
      queryKey: ["github-installation-setup", orgSlug],
      refetchType: "active",
    }),
    queryClient.invalidateQueries({
      queryKey: ["repositories", orgSlug],
      refetchType: "active",
    }),
    queryClient.invalidateQueries({
      queryKey: ["github-installation-repos-preview", orgSlug],
      refetchType: "active",
    }),
    queryClient.invalidateQueries({
      queryKey: githubConnectorKeys.bootstrap(orgSlug),
      refetchType: "active",
    }),
    queryClient.invalidateQueries({
      queryKey: ["github-connector-status", orgSlug],
      refetchType: "active",
    }),
    queryClient.invalidateQueries({
      queryKey: orgConnectionsKeys.list(orgSlug),
      refetchType: "active",
    }),
  ])

  if (status === "no_result") {
    try {
      const response = await client[":orgSlug"].api.v1.github.installation.$get(
        {
          param: { orgSlug },
        },
      )
      if (response.ok) {
        const linked = (await response.json()) as { id: string } | null
        if (linked) status = "registered"
      }
    } catch {
      // Keep "no_result" and let caller decide UX.
    }
  }

  clearGithubPopupFlow()

  return { status }
}

export function consumeNotionSetupPopupResult(): NotionSetupPopupResult {
  const raw = localStorage.getItem(NOTION_SETUP_RESULT_KEY)
  localStorage.removeItem(NOTION_SETUP_RESULT_KEY)
  if (!raw) return { status: "no_result" }

  try {
    const parsed = JSON.parse(raw) as {
      connectionId?: unknown
      error?: unknown
    }
    if (typeof parsed.connectionId === "string" && parsed.connectionId) {
      return { status: "connected", connectionId: parsed.connectionId }
    }
    if (typeof parsed.error === "string" && parsed.error) {
      return { status: "error", error: parsed.error }
    }
  } catch {
    return { status: "error", error: "Failed to read Notion setup result" }
  }

  return { status: "no_result" }
}
