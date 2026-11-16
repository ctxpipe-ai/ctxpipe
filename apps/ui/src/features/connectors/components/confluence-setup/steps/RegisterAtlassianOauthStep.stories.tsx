import type { Meta, StoryObj } from "@storybook/react-vite"

import {
  atlassianOauthHandler,
  atlassianOauthSaveHandler,
} from "@/mocks/atlassian-handlers"
import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../../../../.storybook/decorators/with-story-route"
import { RegisterAtlassianOauthStep } from "./RegisterAtlassianOauthStep"

const orgSlug = "acme"
const atlassianConnectionId = "conn_forge_story"

const meta = {
  title: "Components/Connections/Atlassian/Steps/RegisterOAuth",
  component: RegisterAtlassianOauthStep,
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
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof RegisterAtlassianOauthStep>

export default meta

type Story = StoryObj<typeof meta>

const step = () => (
  <RegisterAtlassianOauthStep
    orgSlug={orgSlug}
    atlassianConnectionId={atlassianConnectionId}
  />
)

export const RegisterOAuth: Story = {
  name: "3LO credential form",
  render: step,
  parameters: {
    review: {
      kind: "component",
      purpose:
        "Step of the self-hosted Confluence setup where the org registers its Atlassian OAuth app: the empty form, no app saved yet.",
    },
    msw: {
      handlers: {
        page: [
          atlassianOauthHandler(
            { oauthAppSaved: false },
            atlassianConnectionId,
          ),
          atlassianOauthSaveHandler(atlassianConnectionId),
        ],
      },
    },
  },
}
