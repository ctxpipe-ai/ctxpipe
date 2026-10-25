export function relativePath(path: string, cwd: string): string {
  return path.startsWith(cwd) ? path.slice(cwd.length + 1) : path
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "")
}

export function mcpUrl({ baseUrl }: { baseUrl: string }): string {
  return new URL("/mcp", normalizeBaseUrl(baseUrl)).toString()
}

export function scopesFor(
  scope: "repo" | "user" | "both",
): Array<"repo" | "user"> {
  if (scope === "both") return ["repo", "user"]
  return [scope]
}
