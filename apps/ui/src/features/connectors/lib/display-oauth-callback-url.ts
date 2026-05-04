/**
 * Storybook/fixtures sometimes use fake hosts (`app.example.com`). In non-production builds,
 * use the browser origin so preview and local dev mirror the URL users paste into Atlassian.
 *
 * Production keeps the server's `oauthCallbackUrl` verbatim so it stays aligned with
 * `AUTH_BASE_URL`/`redirect_uri` on the backend.
 */
export function displayOAuthCallbackUrl(
  fromApi: string | undefined,
): string | undefined {
  if (!fromApi) return undefined
  if (
    typeof window === "undefined" ||
    typeof import.meta === "undefined" ||
    import.meta.env.PROD
  ) {
    return fromApi
  }
  const mockSentinels = ["app.example.com", "placeholder.invalid"]
  if (!mockSentinels.some((s) => fromApi.includes(s))) {
    return fromApi
  }
  try {
    const u = new URL(fromApi)
    return new URL(u.pathname + u.search, window.location.origin).href
  } catch {
    return `${window.location.origin}/api/v1/integrations/atlassian/callback`
  }
}
