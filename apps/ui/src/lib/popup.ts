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

export function onPopupClosed(popup: Window, onClosed: () => void) {
  if (typeof window === "undefined") return () => {}

  const timer = window.setInterval(() => {
    if (!popup.closed) return
    window.clearInterval(timer)
    onClosed()
  }, 400)

  return () => window.clearInterval(timer)
}
