import type { QueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { client } from "@/lib/api"

/**
 * Shared key for the GitHub setup popup to relay `installation_id` back to the
 * opener via localStorage. The popup writes, the opener reads + deletes.
 */
export const GITHUB_SETUP_RESULT_KEY = "github-setup-result"
export const GITHUB_SETUP_ORG_HINT_KEY = "github-setup-org-hint"
export const NOTION_SETUP_RESULT_KEY = "notion-setup-result"

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

  let status: GithubSetupRegistrationStatus = "no_result"

  if (raw) {
    try {
      const { installationId } = JSON.parse(raw) as {
        installationId: number
      }
      if (installationId && orgSlug) {
        const response = await client[
          ":orgSlug"
        ].api.v1.github.installation.$post({
          param: { orgSlug },
          json: { installationId },
        })
        status = response.ok ? "registered" : "registration_failed"
      }
    } catch {
      // Registration may fail — query invalidation below will reflect
      // current server state.
      status = "registration_failed"
    }
  }

  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: ["github-installation", orgSlug],
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
  ])

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
