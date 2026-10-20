/** The token of an `Authorization: Bearer` header, if any. */
export function workspaceChatBearerToken(
  header: string | undefined,
): string | undefined {
  const prefix = "Bearer "
  if (!header?.startsWith(prefix)) return undefined
  const token = header.slice(prefix.length).trim()
  return token.length > 0 ? token : undefined
}
