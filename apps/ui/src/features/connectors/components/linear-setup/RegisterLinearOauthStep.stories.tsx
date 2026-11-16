import type { Meta, StoryObj } from "@storybook/react-vite"

import { linearOauthAppHandler } from "@/mocks/linear-handlers"

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
    review: { kind: "component" },
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
    review: {
      purpose:
        "Linear setup step where the admin registers a private Linear OAuth app: no OAuth app is saved yet.",
    },
    msw: {
      handlers: {
        page: [
          linearOauthAppHandler({
            globalLinearOauthConfigured: false,
            oauthAppSaved: false,
          }),
        ],
      },
    },
  },
}

export const Saved: Story = {
  parameters: {
    review: {
      purpose:
        "Linear setup step where the admin registers a private Linear OAuth app: the OAuth app is already saved.",
    },
    msw: {
      handlers: {
        page: [
          linearOauthAppHandler({
            globalLinearOauthConfigured: false,
            oauthAppSaved: true,
            oauthClientId: "lin_client",
          }),
        ],
      },
    },
  },
}
