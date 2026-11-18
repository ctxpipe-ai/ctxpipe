import type { Meta, StoryObj } from "@storybook/react-vite"

import {
  atlassianOauthHandler,
  atlassianOauthSaveHandler,
} from "@/mocks/atlassian-handlers"
import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../../../../.storybook/decorators/with-story-route"
import { LinkAtlassianStep } from "./LinkAtlassianStep"

const orgSlug = "acme"
const atlassianConnectionId = "conn_forge_story"

const meta = {
  title: "Components/Connections/Atlassian/Steps/LinkAtlassian",
  component: LinkAtlassianStep,
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
    review: { kind: "component" },
  },
} satisfies Meta<typeof LinkAtlassianStep>

export default meta

type Story = StoryObj<typeof meta>

const step = () => (
  <LinkAtlassianStep
    orgSlug={orgSlug}
    atlassianConnectionId={atlassianConnectionId}
  />
)

/**
 * Step of the Confluence setup where the user links an Atlassian account: the
 * org OAuth app is saved, so the user can sign in.
 */
export const LinkAtlassian: Story = {
  name: "Ready to sign in (3LO saved)",
  render: step,
  parameters: {
    msw: {
      handlers: {
        page: [
          atlassianOauthHandler({ oauthAppSaved: true }, atlassianConnectionId),
          atlassianOauthSaveHandler(atlassianConnectionId),
        ],
      },
    },
  },
}

/**
 * Step of the Confluence setup where the user links an Atlassian account: the
 * deployment OAuth app is used, with no org app.
 */
export const GlobalEnvOAuth: Story = {
  name: "Global env OAuth only",
  render: step,
  parameters: {
    msw: {
      handlers: {
        page: [
          atlassianOauthHandler(
            { oauthAppSaved: false, globalAtlassianOAuthConfigured: true },
            atlassianConnectionId,
          ),
        ],
      },
    },
  },
}

/**
 * Step of the Confluence setup where the user links an Atlassian account: no
 * OAuth app is saved, so the step reminds the user to register one.
 */
export const UnsavedSelfHostedReminder: Story = {
  name: "Self-hosted 3LO not saved (wizard orphan edge)",
  render: step,
  parameters: {
    msw: {
      handlers: {
        page: [
          atlassianOauthHandler(
            { oauthAppSaved: false },
            atlassianConnectionId,
          ),
        ],
      },
    },
  },
}
