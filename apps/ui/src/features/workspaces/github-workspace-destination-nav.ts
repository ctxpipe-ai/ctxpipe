export function afterFromSearch(search: unknown): "settings" | undefined {
  if (search && typeof search === "object" && "after" in search) {
    const after = (search as { after?: unknown }).after
    if (after === "settings") return "settings"
  }
  return undefined
}

export function workspaceCreateLandingSearch(
  after?: "settings",
): { pane: "settings" } | undefined {
  return after === "settings" ? { pane: "settings" } : undefined
}
