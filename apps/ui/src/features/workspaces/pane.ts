export type ParsedPane =
  | { kind: "files" }
  | { kind: "graph" }
  | { kind: "settings" }
  /** `turn` limits the pane to one turn; `path` opens and shows that file. */
  | { kind: "diff"; turn?: string; path?: string }
  | { kind: "file"; path: string }
  | { kind: "unknown"; id: string }

export function parsePane(raw: string | undefined): ParsedPane | null {
  if (raw == null || raw === "") return null
  if (raw === "files") return { kind: "files" }
  if (raw === "graph") return { kind: "graph" }
  if (raw === "settings") return { kind: "settings" }
  if (raw === "diff") return { kind: "diff" }
  if (raw.startsWith("diff:")) {
    const params = new URLSearchParams(raw.slice("diff:".length))
    const turn = params.get("turn") || undefined
    const path = params.get("path") || undefined
    return {
      kind: "diff",
      ...(turn ? { turn } : {}),
      ...(path ? { path } : {}),
    }
  }
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
  if (pane.kind === "diff" && (pane.turn || pane.path)) {
    const params = new URLSearchParams()
    if (pane.turn) params.set("turn", pane.turn)
    if (pane.path) params.set("path", pane.path)
    return `diff:${params.toString()}`
  }
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

/**
 * Search for a move to a different conversation or to a new chat. A file
 * or diff pane belongs to one conversation, so a file pane becomes the Files
 * pane and a diff pane closes. Files, graph, and settings stay open.
 */
export function paneSearchForOtherConversation(
  search: Record<string, unknown>,
): {
  pane?: string
} {
  const pane = parsePane(workspaceSearch(search).pane)
  if (pane?.kind === "file") return { pane: "files" }
  if (pane?.kind === "diff") return { pane: undefined }
  return workspaceSearch(search)
}
