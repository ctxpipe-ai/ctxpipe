import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { fn } from "storybook/test"
import { AddLinearConnectorButton } from "./AddLinearConnectorButton"

const meta = {
  title: "Components/Connections/Linear/AddConnectorButton",
  component: AddLinearConnectorButton,
  parameters: {
    layout: "centered",
    msw: {
      handlers: {
        page: [
          http.get("/acme/api/v1/connectors/linear/oauth-app", () =>
            HttpResponse.json({
              linearOauthConfigured: true,
              globalLinearOauthConfigured: true,
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
  args: { orgSlug: "acme", onStart: fn() },
  decorators: [
    (Story) => (
      <div className="w-[min(32rem,90vw)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AddLinearConnectorButton>

export default meta

type Story = StoryObj<typeof meta>

export const Available: Story = {}
