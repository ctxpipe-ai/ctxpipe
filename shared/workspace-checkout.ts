/** Immutable source artifacts are separate from workspace projection checkouts. */
export function repositoryRevisionCheckoutKey(sha: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))
    throw new Error("Repository checkout requires an immutable commit SHA")
  return `rev:${sha}`
}
