import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../../../.storybook/decorators/with-story-route"
import preview from "../../../../../.storybook/preview"
import {
  notionOauthAppHandler,
  notionOauthAppPutHandler,
} from "../../mocks/notion-oauth-app-msw"
import { RegisterNotionOauthStep } from "./RegisterNotionOauthStep"

const orgSlug = "acme"
const connectionId = "con_story_notion"

const meta = preview.meta({
  title: "Components/Connections/Notion/Steps/RegisterOAuth",
  component: RegisterNotionOauthStep,
  args: {
    orgSlug,
    connectionId,
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

/**
 * Notion setup step where the admin registers a private Notion OAuth app: the
 * empty form, with no OAuth app saved yet.
 */
export const RegisterOAuth = meta.story({
  name: "Private OAuth app form",
  render: () => (
    <RegisterNotionOauthStep orgSlug={orgSlug} connectionId={connectionId} />
  ),
  beforeEach: ({ msw }) => {
    msw.use(
      notionOauthAppHandler({
        orgSlug,
        connectionId,
        oauthAppSaved: false,
        globalNotionOAuthConfigured: false,
      }),
      notionOauthAppPutHandler({ orgSlug, connectionId }),
    )
  },
})
