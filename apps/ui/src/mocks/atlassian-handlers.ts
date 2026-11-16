import { HttpResponse, http } from "msw"

import { type MockState, mockResponse } from "./mock-state"

function pathnameOf(request: Request) {
  return new URL(request.url).pathname
}

/**
 * `GET …/capabilities`: the Confluence Forge install link of the host. Null
 * means no hosted link: the admin installs the app by hand.
 */
export function atlassianCapabilitiesHandler(
  installUrl: MockState<string | null>,
) {
  return http.get(
    ({ request }) => pathnameOf(request).endsWith("/api/v1/capabilities"),
    () =>
      mockResponse(installUrl, (installUrl) =>
        HttpResponse.json({ confluenceForgeInstallUrl: installUrl }),
      ),
  )
}

/** `GET …/org/atlassian-oauth`: the Atlassian OAuth app of a connection. */
export function atlassianOauthHandler(
  app: MockState<{
    oauthAppSaved: boolean
    globalAtlassianOAuthConfigured?: boolean
  }>,
) {
  return http.get(
    ({ request }) =>
      pathnameOf(request).endsWith("/api/v1/org/atlassian-oauth"),
    ({ request }) =>
      mockResponse(app, (app) =>
        HttpResponse.json({
          oauthAppSaved: app.oauthAppSaved,
          atlassianOAuthClientId: app.oauthAppSaved
            ? "atlassian-oauth-client-id-story"
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
