/** Same-origin relative path only. Rejects protocol-relative and absolute URLs. */
export function safeAuthRedirectPath(
  value: string | null | undefined,
  fallback: string,
): string {
  if (!value) return fallback
  if (!value.startsWith("/")) return fallback
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback
  if (value.includes("://")) return fallback
  return value
}
