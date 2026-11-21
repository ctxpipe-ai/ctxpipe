import {
  atlassianOauthHandler,
  atlassianOauthSaveHandler,
} from "@/mocks/atlassian-handlers"
import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../../../../.storybook/decorators/with-story-route"
import preview from "../../../../../../.storybook/preview"
import { RegisterAtlassianOauthStep } from "./RegisterAtlassianOauthStep"

const orgSlug = "acme"
const atlassianConnectionId = "conn_forge_story"

const meta = preview.meta({
  title: "Components/Connections/Atlassian/Steps/RegisterOAuth",
  component: RegisterAtlassianOauthStep,
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
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
})

const step = () => (
  <RegisterAtlassianOauthStep
    orgSlug={orgSlug}
    atlassianConnectionId={atlassianConnectionId}
  />
)

/**
 * Step of the self-hosted Confluence setup where the org registers its
 * Atlassian OAuth app: the empty form, no app saved yet.
 */
export const RegisterOAuth = meta.story({
  name: "3LO credential form",
  render: step,
  beforeEach: ({ msw }) => {
    msw.use(
      atlassianOauthHandler({ oauthAppSaved: false }, atlassianConnectionId),
      atlassianOauthSaveHandler(atlassianConnectionId),
    )
  },
  parameters: {
    review: {
      kind: "component",
    },
  },
})
