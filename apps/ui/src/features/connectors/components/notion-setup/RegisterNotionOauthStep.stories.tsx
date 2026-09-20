import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../../.storybook/decorators/with-story-route"
import { RegisterNotionOauthStep } from "./RegisterNotionOauthStep"

const orgSlug = "acme"
const connectionId = "con_story_notion"

const meta = {
  title: "Components/Connections/Notion/Steps/RegisterOAuth",
  component: RegisterNotionOauthStep,
  decorators: [
    (Story) => (
      <div className="w-full max-w-md p-2">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof RegisterNotionOauthStep>

export default meta

type Story = StoryObj<typeof meta>

const oauthAppHandler = (
  oauthAppSaved: boolean,
  globalNotionOAuthConfigured = false,
) =>
  http.get(
    ({ request }) => {
      const u = new URL(request.url)
      return (
        u.pathname === `/${orgSlug}/api/v1/connectors/notion/oauth-app` &&
        u.searchParams.get("connectionId") === connectionId
      )
    },
    ({ request }) => {
      const origin = new URL(request.url).origin
      return HttpResponse.json({
        oauthConfigured: oauthAppSaved || globalNotionOAuthConfigured,
        oauthAppSaved,
        oauthClientId: oauthAppSaved ? "notion-oauth-client-id-story" : null,
        webhookConfigured: oauthAppSaved || globalNotionOAuthConfigured,
        globalNotionOAuthConfigured,
        callbackUrl: `${origin}/api/v1/connectors/notion/oauth/callback`,
        webhookUrl: oauthAppSaved
          ? `${origin}/api/v1/webhook/notion?connectionId=${connectionId}&provisioningToken=story`
          : `${origin}/api/v1/webhook/notion`,
      })
    },
  )

const oauthAppPut = http.put(
  ({ request }) => {
    const u = new URL(request.url)
    return (
      u.pathname === `/${orgSlug}/api/v1/connectors/notion/oauth-app` &&
      u.searchParams.get("connectionId") === connectionId
    )
  },
  () => new HttpResponse(null, { status: 204 }),
)

const step = () => (
  <RegisterNotionOauthStep
    orgSlug={orgSlug}
    connectionId={connectionId}
    onConnect={() => {}}
  />
)

export const RegisterOAuth: Story = {
  name: "Public integration form",
  render: step,
  parameters: {
    msw: {
      handlers: {
        page: [oauthAppHandler(false, false), oauthAppPut],
      },
    },
  },
}

export const RegisterOAuthSaved: Story = {
  name: "Saved integration — Event URL",
  render: step,
  parameters: {
    msw: {
      handlers: {
        page: [oauthAppHandler(true, false), oauthAppPut],
      },
    },
  },
}
