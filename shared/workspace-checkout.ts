function workspaceCheckoutBase(workspaceId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceId))
    throw new Error("Invalid workspace id")
  return `ws:${workspaceId}`
}

/** The prefix of the Workspace keys of one Workspace. */
function workspaceCheckoutPrefix(workspaceId: string): string {
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

/** Immutable source artifacts are separate from workspace projection checkouts. */
export function repositoryRevisionCheckoutKey(sha: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))
    throw new Error("Repository checkout requires an immutable commit SHA")
  return `rev:${sha}`
}
