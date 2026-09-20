import { HttpResponse, http } from "msw"

export function notionOauthAppHandler(input: {
  orgSlug: string
  connectionId: string
  oauthAppSaved?: boolean
  globalNotionOAuthConfigured?: boolean
  oauthClientId?: string | null
  webhookConfigured?: boolean
  webhookUrl?: string
}) {
  const oauthAppSaved = input.oauthAppSaved ?? false
  const globalNotionOAuthConfigured = input.globalNotionOAuthConfigured ?? false
  const webhookConfigured =
    input.webhookConfigured ?? oauthAppSaved || globalNotionOAuthConfigured
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      return (
        u.pathname ===
          `/${input.orgSlug}/api/v1/connectors/notion/oauth-app` &&
        u.searchParams.get("connectionId") === input.connectionId
      )
    },
    ({ request }) => {
      const origin = new URL(request.url).origin
      return HttpResponse.json({
        oauthConfigured: oauthAppSaved || globalNotionOAuthConfigured,
        oauthAppSaved,
        oauthClientId:
          input.oauthClientId ?? (oauthAppSaved ? "notion-client-id" : null),
        webhookConfigured,
        globalNotionOAuthConfigured,
        callbackUrl: `${origin}/api/v1/connectors/notion/oauth/callback`,
        webhookUrl:
          input.webhookUrl ??
          (oauthAppSaved
            ? `${origin}/api/v1/webhook/notion?connectionId=${input.connectionId}&provisioningToken=story`
            : `${origin}/api/v1/webhook/notion`),
      })
    },
  )
}

export function notionOauthAppPutHandler(input: {
  orgSlug: string
  connectionId: string
}) {
  return http.put(
    ({ request }) => {
      const u = new URL(request.url)
      return (
        u.pathname ===
          `/${input.orgSlug}/api/v1/connectors/notion/oauth-app` &&
        u.searchParams.get("connectionId") === input.connectionId
      )
    },
    () => new HttpResponse(null, { status: 204 }),
  )
}
