import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { OrgAtlassianOauthPanel } from "./OrgAtlassianOauthPanel"

const orgSlug = "acme"
const connectionId = "con_panel_story"

const meta = {
  title: "Components/Connections/Atlassian/OAuthPanel",
  component: OrgAtlassianOauthPanel,
  decorators: [
    (Story) => (
      <div className="w-full min-w-[min(100vw,28rem)]">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
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
    ({ request }) =>
      HttpResponse.json({
        oauthAppSaved,
        atlassianOAuthClientId: oauthAppSaved
          ? "atlassian-oauth-client-id-story"
          : null,
        globalAtlassianOAuthConfigured,
        oauthCallbackUrl: `${new URL(request.url).origin}/api/v1/integrations/atlassian/callback`,
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

const panel = () => (
  <OrgAtlassianOauthPanel orgSlug={orgSlug} connectionId={connectionId} />
)

export const OAuthPanel: Story = {
  render: panel,
  parameters: {
    msw: {
      handlers: {
        page: baseHandlers,
      },
    },
  },
}

export const OauthAppSaved: Story = {
  render: panel,
  parameters: {
    msw: {
      handlers: {
        page: [getOrgOauth(true, false), putOrgOauth],
      },
    },
  },
}

export const Embedded: Story = {
  name: "Embedded (wizard)",
  render: () => (
    <OrgAtlassianOauthPanel
      embedded
      orgSlug={orgSlug}
      connectionId={connectionId}
    />
  ),
  parameters: {
    msw: {
      handlers: {
        page: baseHandlers,
      },
    },
  },
}

export const EmbeddedOauthConfigured: Story = {
  name: "Embedded + OAuth configured",
  render: () => (
    <OrgAtlassianOauthPanel
      embedded
      orgSlug={orgSlug}
      connectionId={connectionId}
    />
  ),
  parameters: {
    msw: {
      handlers: {
        page: [getOrgOauth(true, false), putOrgOauth],
      },
    },
  },
}
