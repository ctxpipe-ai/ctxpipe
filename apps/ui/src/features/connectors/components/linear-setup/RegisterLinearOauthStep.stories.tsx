import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../../.storybook/decorators/with-story-route"
import { RegisterLinearOauthStep } from "./RegisterLinearOauthStep"

const orgSlug = "acme"
const connectionId = "linear_story"

const meta = {
  title: "Components/Connections/Linear/RegisterOauthStep",
  component: RegisterLinearOauthStep,
  decorators: entryPageInnerDecorators,
  args: { orgSlug, connectionId },
  parameters: {
    layout: "padded",
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof RegisterLinearOauthStep>

export default meta

type Story = StoryObj<typeof meta>

export const Unsaved: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(`/${orgSlug}/api/v1/connectors/linear/oauth-app`, () =>
            HttpResponse.json({
              linearOauthConfigured: false,
              globalLinearOauthConfigured: false,
              oauthCallbackUrl:
                "https://app.example.com/api/v1/integrations/linear/callback",
              linearWebhookUrl: "https://app.example.com/api/v1/webhook/linear",
              linearCreateUrl:
                "https://linear.app/settings/api/applications/new",
              oauthAppSaved: false,
              oauthClientId: null,
            }),
          ),
        ],
      },
    },
  },
}

export const Saved: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(`/${orgSlug}/api/v1/connectors/linear/oauth-app`, () =>
            HttpResponse.json({
              linearOauthConfigured: true,
              globalLinearOauthConfigured: false,
              oauthCallbackUrl:
                "https://app.example.com/api/v1/integrations/linear/callback",
              linearWebhookUrl: "https://app.example.com/api/v1/webhook/linear",
              linearCreateUrl:
                "https://linear.app/settings/api/applications/new",
              oauthAppSaved: true,
              oauthClientId: "lin_client",
            }),
          ),
        ],
      },
    },
  },
}
