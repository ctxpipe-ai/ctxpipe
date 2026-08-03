export type ZoektRepositoryIdentity = {
  orgId: string
  repoId: string
}

/**
 * Stable Zoekt repository Name. Keep display names out of this identity: two
 * orgs can have the same `owner/repo`, and repository display names can move.
 */
export function zoektRepositoryName(identity: ZoektRepositoryIdentity): string {
  return `ctxpipe:v1:org:${identity.orgId}:repo:${identity.repoId}`
}

/**
 * Filename prefix that `zoekt-index` embeds for a repository Name.
 * Upstream uses `url.QueryEscape` on the name before `_{v}{n}.zoekt`
 * (see sourcegraph/zoekt index/shard_builder.go shardName).
 */
export function zoektShardFilePrefix(zoektName: string): string {
  return `${encodeURIComponent(zoektName)}_`
}

function zoektNameFromShardBasename(basename: string): string | null {
  const match = /^(.+)_v\d+\.\d{5}\.zoekt(?:\.meta)?$/.exec(basename)
  const encodedName = match?.[1]
  if (!encodedName) return null
  try {
    return decodeURIComponent(encodedName.replaceAll("+", "%20"))
  } catch {
    return null
  }
}

/** True if basename is a cold shard (or .meta sidecar) for an exact Zoekt Name. */
export function isZoektShardBasenameForName(
  basename: string,
  zoektName: string,
): boolean {
  return zoektNameFromShardBasename(basename) === zoektName
}
