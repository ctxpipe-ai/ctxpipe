import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../../../.storybook/decorators/with-story-route"
import preview from "../../../../../.storybook/preview"
import { notionOauthAppHandler } from "../../mocks/notion-oauth-app-msw"
import { AddNotionWebhookStep } from "./AddNotionWebhookStep"

const orgSlug = "acme"
const connectionId = "con_story_notion"

const meta = preview.meta({
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
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers)
  },
  parameters: {
    app: "root",
    layout: "centered",
    review: { kind: "component" },
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
})

const step = () => (
  <AddNotionWebhookStep
    orgSlug={orgSlug}
    connectionId={connectionId}
    onContinue={() => {}}
  />
)

/**
 * Notion setup step where the admin adds the webhook in Notion: ctxpipe still
 * waits for the Notion verification token.
 */
export const WaitingForToken = meta.story({
  name: "Waiting for verification token",
  render: step,
  beforeEach: ({ msw }) => {
    msw.use(
      notionOauthAppHandler({
        orgSlug,
        connectionId,
        oauthAppSaved: true,
        globalNotionOAuthConfigured: false,
        webhookConfigured: false,
        webhookVerificationToken: null,
      }),
    )
  },
})

/**
 * Notion setup step where the admin adds the webhook in Notion: the
 * verification token arrived and shows for the admin to copy.
 */
export const TokenReceived = meta.story({
  name: "Verification token received",
  render: step,
  beforeEach: ({ msw }) => {
    msw.use(
      notionOauthAppHandler({
        orgSlug,
        connectionId,
        oauthAppSaved: true,
        globalNotionOAuthConfigured: false,
        webhookConfigured: true,
        webhookVerificationToken: "secret_story-verify-token",
      }),
    )
  },
})
