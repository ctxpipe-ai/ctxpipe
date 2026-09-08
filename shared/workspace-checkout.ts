/** Omitted SHA denotes only the temporary legacy checkout. */
export function workspaceCheckoutKey(
  workspaceId: string,
  sha?: string,
): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceId))
    throw new Error("Invalid workspace id")
  if (sha !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))
    throw new Error("Workspace checkout requires an immutable commit SHA")
  return sha ? `ws:${workspaceId}:${sha}` : `ws:${workspaceId}`
}
