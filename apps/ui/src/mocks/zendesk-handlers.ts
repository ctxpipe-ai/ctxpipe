import { HttpResponse, http } from "msw"

import type {
  ZendeskCatalog,
  ZendeskConnectorStatus,
} from "@/features/connectors/queries/zendesk-connector"

/** The categories and views that the story connection can read. */
const ZENDESK_STORY_CATALOG: ZendeskCatalog = {
  categories: [
    { id: "360001", name: "Accounts" },
    { id: "360002", name: "Billing" },
    { id: "360003", name: "Release notes" },
  ],
  views: [
    { id: "900001", title: "Escalated to engineering" },
    { id: "900002", title: "Bugs" },
  ],
}

export const zendeskStoryStatus = (
  overrides: Partial<ZendeskConnectorStatus> = {},
): ZendeskConnectorStatus => ({
  status: "installed",
  subdomain: "acme",
  oauthClientConfigured: true,
  oauthClientId: "ctxpipe-dev",
  deploymentOAuthClient: false,
  redirectUri: "https://app.example.com/api/v1/integrations/zendesk/callback",
  webhookConfigured: true,
  ...overrides,
})

export function zendeskStatusHandler(status: ZendeskConnectorStatus) {
  return http.get(
    ({ request }) =>
      new URL(request.url).pathname.endsWith(
        "/api/v1/connectors/zendesk/status",
      ),
    () => HttpResponse.json(status),
  )
}

/** The scope picker's list of categories and views. */
export const zendeskCatalogHandler = http.get(
  ({ request }) =>
    new URL(request.url).pathname.endsWith(
      "/api/v1/connectors/zendesk/catalog",
    ),
  () => HttpResponse.json(ZENDESK_STORY_CATALOG),
)
