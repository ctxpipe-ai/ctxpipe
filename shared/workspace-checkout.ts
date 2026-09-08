function workspaceCheckoutBase(workspaceId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceId))
    throw new Error("Invalid workspace id")
  return `ws:${workspaceId}`
}

/** Bind this prefix in SQL when the immutable SHA is a database expression. */
export function workspaceCheckoutPrefix(workspaceId: string): string {
  return `${workspaceCheckoutBase(workspaceId)}:`
}

/** Omitted SHA denotes only the temporary legacy checkout. */
export function workspaceCheckoutKey(
  workspaceId: string,
  sha?: string,
): string {
  if (sha === undefined) return workspaceCheckoutBase(workspaceId)
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))
    throw new Error("Workspace checkout requires an immutable commit SHA")
  return `${workspaceCheckoutPrefix(workspaceId)}${sha}`
}
