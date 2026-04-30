import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../../../.storybook/decorators/with-story-route"
import { RegisterAtlassianOauthStep } from "./RegisterAtlassianOauthStep"

const orgSlug = "acme"
const atlassianConnectionId = "conn_forge_story"

const meta = {
  title:
    "Components/Connections/Atlassian/Steps/Register Atlassian OAuth (3LO)",
  component: RegisterAtlassianOauthStep,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof RegisterAtlassianOauthStep>

export default meta

type Story = StoryObj<typeof meta>

const orgOauthHandler = (
  oauthAppSaved: boolean,
  globalAtlassianOAuthConfigured = false,
) =>
  http.get(
    ({ request }) => {
      const u = new URL(request.url)
      return (
        u.pathname === `/${orgSlug}/api/v1/org/atlassian-oauth` &&
        u.searchParams.get("connectionId") === atlassianConnectionId
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

const orgOauthPut = http.put(
  ({ request }) => {
    const u = new URL(request.url)
    return (
      u.pathname === `/${orgSlug}/api/v1/org/atlassian-oauth` &&
      u.searchParams.get("connectionId") === atlassianConnectionId
    )
  },
  () => new HttpResponse(null, { status: 204 }),
)

export const Default: Story = {
  name: "3LO credential form",
  render: () => (
    <div className="w-full max-w-md p-2">
      <RegisterAtlassianOauthStep
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [orgOauthHandler(false, false), orgOauthPut],
      },
    },
  },
}
