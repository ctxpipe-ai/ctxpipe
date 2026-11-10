type ZoektRepositoryIdentity = {
  orgId: string
  repoId: string
  checkoutKey?: string
}

/**
 * Stable Zoekt repository Name. Keep display names out of this identity: two
 * orgs can have the same `owner/repo`, and repository display names can move.
 * Workspace checkouts append the checkout key so two Workspaces do not share a shard.
 */
export function zoektRepositoryName(identity: ZoektRepositoryIdentity): string {
  const base = `ctxpipe:v1:org:${identity.orgId}:repo:${identity.repoId}`
  if (identity.checkoutKey && identity.checkoutKey !== "default") {
    return `${base}:checkout:${identity.checkoutKey}`
  }
  return base
}

/**
 * The identity in a Zoekt repository Name: the inverse of
 * `zoektRepositoryName`. Gives null for a name of another shape.
 */
export function zoektRepositoryIdentity(
  zoektName: string,
): Required<ZoektRepositoryIdentity> | null {
  const match = /^ctxpipe:v1:org:([^:]+):repo:([^:]+)(?::checkout:(.+))?$/.exec(
    zoektName,
  )
  if (!match?.[1] || !match[2]) return null
  return {
    orgId: match[1],
    repoId: match[2],
    checkoutKey: match[3] ?? "default",
  }
}

/**
 * Filename prefix that `zoekt-index` embeds for a repository Name.
 * Upstream uses `url.QueryEscape` on the name before `_{v}{n}.zoekt`
 * (see sourcegraph/zoekt index/shard_builder.go shardName).
 */
export function zoektShardFilePrefix(zoektName: string): string {
  return `${encodeURIComponent(zoektName)}_`
}

/**
 * Reads the Zoekt repository Name from a shard file name: a shard
 * (`<name>_v16.00000.zoekt`), its `.meta` sidecar, or a temporary file that a
 * stopped build left (`<shard>.<n>.tmp`). Gives null for any other file name.
 */
export function parseZoektShardBasename(
  basename: string,
): { zoektName: string; temporary: boolean } | null {
  const match = /^(.+)_v\d+\.\d{5}\.zoekt(?:\.meta)?(\.[^.]+\.tmp)?$/.exec(
    basename,
  )
  const encodedName = match?.[1]
  if (!encodedName) return null
  try {
    return {
      zoektName: decodeURIComponent(encodedName.replaceAll("+", "%20")),
      temporary: Boolean(match[2]),
    }
  } catch {
    return null
  }
}

/** True if basename is a cold shard (or .meta sidecar) for an exact Zoekt Name. */
export function isZoektShardBasenameForName(
  basename: string,
  zoektName: string,
): boolean {
  const parsed = parseZoektShardBasename(basename)
  return parsed !== null && !parsed.temporary && parsed.zoektName === zoektName
}
