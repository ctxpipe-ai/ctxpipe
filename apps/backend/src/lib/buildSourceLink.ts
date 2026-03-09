/**
 * Builds a source link for evidence provenance.
 * When sourceUrl is provided (e.g. external Confluence, GitHub, PagerDuty link), use it directly.
 * Otherwise construct from orgSlug, sourceType, and sourceId.
 */
export function buildSourceLink(params: {
  orgSlug: string
  sourceType: string
  sourceId: string
  sourceUrl?: string | null
}): string {
  if (params.sourceUrl?.trim()) {
    return params.sourceUrl.trim()
  }
  return `/${params.orgSlug}/sources/${encodeURIComponent(params.sourceType)}/${encodeURIComponent(params.sourceId)}`
}
