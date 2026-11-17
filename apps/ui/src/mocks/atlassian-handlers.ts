import { HttpResponse, http } from "msw"

import { type MockState, mockResponse } from "./mock-state"

/** Whether the request goes to `path` for `connectionId`. */
function matches(request: Request, path: string, connectionId: string) {
  const url = new URL(request.url)
  return (
    url.pathname.endsWith(path) &&
    url.searchParams.get("connectionId") === connectionId
  )
}

/**
 * `GET …/capabilities`: the Confluence Forge install link of the host. Null
 * means no hosted link: the admin installs the app by hand.
 */
export function atlassianCapabilitiesHandler(
  installUrl: MockState<string | null>,
  connectionId: string,
) {
  return http.get(
    ({ request }) => matches(request, "/api/v1/capabilities", connectionId),
    () =>
      mockResponse(installUrl, (installUrl) =>
        HttpResponse.json({ confluenceForgeInstallUrl: installUrl }),
      ),
  )
}

/**
 * `GET …/org/atlassian-oauth`: the Atlassian OAuth app of a connection. It
 * answers only `connectionId`.
 */
export function atlassianOauthHandler(
  app: MockState<{
    oauthAppSaved: boolean
    globalAtlassianOAuthConfigured?: boolean
  }>,
  connectionId: string,
) {
  return http.get(
    ({ request }) =>
      matches(request, "/api/v1/org/atlassian-oauth", connectionId),
    ({ request }) =>
      mockResponse(app, (app) =>
        HttpResponse.json({
          oauthAppSaved: app.oauthAppSaved,
          atlassianOAuthClientId: app.oauthAppSaved
            ? "q7Hc2LmN4pXw9RtB3vKe6YsJ8aDf1GzU"
            : null,
          globalAtlassianOAuthConfigured:
            app.globalAtlassianOAuthConfigured ?? false,
          oauthCallbackUrl: `${new URL(request.url).origin}/api/v1/integrations/atlassian/callback`,
          atlassianCreateUrl:
            "https://developer.atlassian.com/cloud/oauth-2-3lo-apps",
        }),
      ),
  )
}

/**
 * `PUT …/org/atlassian-oauth`: the server saves the Atlassian OAuth app of a
 * connection. It answers only `connectionId`.
 */
export function atlassianOauthSaveHandler(connectionId: string) {
  return http.put(
    ({ request }) =>
      matches(request, "/api/v1/org/atlassian-oauth", connectionId),
    () => new HttpResponse(null, { status: 204 }),
  )
}
