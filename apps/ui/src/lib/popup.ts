import { useEffect, useRef } from "react"

/**
 * Shared key for the GitHub setup popup to relay `installation_id` back to the
 * opener via localStorage. The popup writes, the opener reads + deletes.
 */
export const GITHUB_SETUP_RESULT_KEY = "github-setup-result"

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
