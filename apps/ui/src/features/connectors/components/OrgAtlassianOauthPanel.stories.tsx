import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { OrgAtlassianOauthPanel } from "./OrgAtlassianOauthPanel"

const orgSlug = "acme"
const connectionId = "con_panel_story"

const meta = {
  title: "Components/Connections/Atlassian/OrgAtlassianOauthPanel",
  component: OrgAtlassianOauthPanel,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof OrgAtlassianOauthPanel>

export default meta

type Story = StoryObj<typeof meta>

const getOrgOauth = (
  oauthAppSaved: boolean,
  globalAtlassianOAuthConfigured = false,
) =>
  http.get(
    ({ request }) => {
      const u = new URL(request.url)
      return (
        u.pathname === `/${orgSlug}/api/v1/org/atlassian-oauth` &&
        u.searchParams.get("connectionId") === connectionId
      )
    },
    () =>
      HttpResponse.json({
        oauthAppSaved,
        atlassianOAuthClientId: oauthAppSaved
          ? "atlassian-oauth-client-id-story"
          : null,
        globalAtlassianOAuthConfigured,
        oauthCallbackUrl:
          "https://app.example.com/api/v1/integrations/atlassian/callback",
        atlassianCreateUrl:
          "https://developer.atlassian.com/cloud/oauth-2-3lo-apps",
      }),
  )

const putOrgOauth = http.put(
  ({ request }) => {
    const u = new URL(request.url)
    return (
      u.pathname === `/${orgSlug}/api/v1/org/atlassian-oauth` &&
      u.searchParams.get("connectionId") === connectionId
    )
  },
  () => new HttpResponse(null, { status: 204 }),
)

const baseHandlers = [getOrgOauth(false, false), putOrgOauth]

export const Default: Story = {
  render: () => (
    <div className="w-full min-w-[min(100vw,28rem)] p-2">
      <OrgAtlassianOauthPanel orgSlug={orgSlug} connectionId={connectionId} />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: baseHandlers,
      },
    },
  },
}

export const OauthAppSaved: Story = {
  render: Default.render,
  parameters: {
    msw: {
      handlers: {
        page: [getOrgOauth(true, false), putOrgOauth],
      },
    },
  },
}

/** Same fields as in the first wizard step, without the connector card border. */
export const Embedded: Story = {
  name: "Embedded (wizard)",
  render: () => (
    <div className="w-full min-w-[min(100vw,28rem)] p-2">
      <OrgAtlassianOauthPanel
        embedded
        orgSlug={orgSlug}
        connectionId={connectionId}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: baseHandlers,
      },
    },
  },
}
