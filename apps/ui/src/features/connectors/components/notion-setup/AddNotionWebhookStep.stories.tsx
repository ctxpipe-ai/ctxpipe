import type { Meta, StoryObj } from "@storybook/react-vite"

import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../../../.storybook/decorators/with-story-route"
import { notionOauthAppHandler } from "../../mocks/notion-oauth-app-msw"
import { AddNotionWebhookStep } from "./AddNotionWebhookStep"

const orgSlug = "acme"
const connectionId = "con_story_notion"

const meta = {
  title: "Components/Connections/Notion/Steps/AddWebhook",
  component: AddNotionWebhookStep,
  args: {
    orgSlug,
    connectionId,
    onContinue: () => {},
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-md p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    msw: { handlers: { session: signedInHandlers } },
    app: "root",
    queryClient: true,
    layout: "centered",
    review: { kind: "component" },
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof AddNotionWebhookStep>

export default meta

type Story = StoryObj<typeof meta>

const step = () => (
  <AddNotionWebhookStep
    orgSlug={orgSlug}
    connectionId={connectionId}
    onContinue={() => {}}
  />
)

export const WaitingForToken: Story = {
  name: "Waiting for verification token",
  render: step,
  parameters: {
    review: {
      purpose:
        "Notion setup step where the admin adds the webhook in Notion: ctxpipe still waits for the Notion verification token.",
    },
    msw: {
      handlers: {
        page: [
          notionOauthAppHandler({
            orgSlug,
            connectionId,
            oauthAppSaved: true,
            globalNotionOAuthConfigured: false,
            webhookConfigured: false,
            webhookVerificationToken: null,
          }),
        ],
      },
    },
  },
}

export const TokenReceived: Story = {
  name: "Verification token received",
  render: step,
  parameters: {
    review: {
      purpose:
        "Notion setup step where the admin adds the webhook in Notion: the verification token arrived and shows for the admin to copy.",
    },
    msw: {
      handlers: {
        page: [
          notionOauthAppHandler({
            orgSlug,
            connectionId,
            oauthAppSaved: true,
            globalNotionOAuthConfigured: false,
            webhookConfigured: true,
            webhookVerificationToken: "secret_story-verify-token",
          }),
        ],
      },
    },
  },
}
