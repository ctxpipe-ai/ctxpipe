/**
 * Filename prefix that `zoekt-index` embeds for a repository Name.
 * Upstream uses `url.QueryEscape` on the name before `_{v}{n}.zoekt`
 * (see sourcegraph/zoekt index/shard_builder.go shardName).
 *
 * `encodeURIComponent` matches QueryEscape for typical `owner/repo` names
 * (`/` → `%2F`). Example: `kubernetes/kubernetes` → `kubernetes%2Fkubernetes_`.
 */
export function zoektShardFilePrefix(repoName: string): string {
  return `${encodeURIComponent(repoName)}_`
}

/** True if basename is a cold shard (or .meta sidecar) for repoName. */
export function isZoektShardBasenameForRepo(
  basename: string,
  repoName: string,
): boolean {
  const prefix = zoektShardFilePrefix(repoName)
  if (!basename.startsWith(prefix)) return false
  return basename.endsWith(".zoekt") || basename.endsWith(".zoekt.meta")
}
