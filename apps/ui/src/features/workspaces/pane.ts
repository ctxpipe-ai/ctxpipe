export type PaneKind = "files" | "graph" | "settings" | "file" | "unknown"

export type ParsedPane =
  | { kind: "files" }
  | { kind: "graph" }
  | { kind: "settings" }
  | { kind: "file"; path: string }
  | { kind: "unknown"; id: string }

export function parsePane(raw: string | undefined): ParsedPane | null {
  if (raw == null || raw === "") return null
  if (raw === "files") return { kind: "files" }
  if (raw === "graph") return { kind: "graph" }
  if (raw === "settings") return { kind: "settings" }
  if (raw.startsWith("file:")) {
    const encoded = raw.slice("file:".length)
    let path = encoded
    try {
      path = decodeURIComponent(encoded)
    } catch {
      path = encoded
    }
    if (!path) return { kind: "unknown", id: raw }
    return { kind: "file", path }
  }
  return { kind: "unknown", id: raw }
}

export function serializePane(pane: ParsedPane): string {
  if (pane.kind === "file") return `file:${encodeURIComponent(pane.path)}`
  if (pane.kind === "unknown") return pane.id
  return pane.kind
}

export function visiblePane(pane: ParsedPane | null): ParsedPane | null {
  if (!pane || pane.kind === "unknown") return null
  return pane
}

/** Absent `?pane=` is closed. An explicit id opens that pane. */
export function landingPane(paneParam?: string): ParsedPane | null {
  return visiblePane(parsePane(paneParam))
}

export function filePaneId(path: string): string {
  return `file:${encodeURIComponent(path)}`
}

export function workspaceSearch(search: Record<string, unknown>): {
  pane?: string
} {
  return {
    pane: typeof search.pane === "string" ? search.pane : undefined,
  }
}
