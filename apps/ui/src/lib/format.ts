/** Relative time or locale date for ISO date strings. Uses Intl for i18n. */
export function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffSecs = Math.floor(diffMs / 1_000)

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

  if (diffSecs < 60) return rtf.format(-diffSecs, "second")

  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 60) return rtf.format(-diffMins, "minute")

  const diffHours = Math.floor(diffMs / 3_600_000)
  if (diffHours < 24) return rtf.format(-diffHours, "hour")

  const diffDays = Math.floor(diffMs / 86_400_000)
  if (diffDays < 7) return rtf.format(-diffDays, "day")

  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(d)
}
