import { signedInHandlers } from "@/mocks/handlers"
import { linearOauthAppHandler } from "@/mocks/linear-handlers"

import type { StoryRouteParams } from "../../../../../.storybook/decorators/with-story-route"
import preview from "../../../../../.storybook/preview"
import { RegisterLinearOauthStep } from "./RegisterLinearOauthStep"

const orgSlug = "acme"
const connectionId = "linear_story"

const meta = preview.meta({
  title: "Components/Connections/Linear/RegisterOauthStep",
  component: RegisterLinearOauthStep,
  args: { orgSlug, connectionId },
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers)
  },
  parameters: {
    app: "root",
    layout: "padded",
    review: { kind: "component" },
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
  },
})

/**
 * Linear setup step where the admin registers a private Linear OAuth app: no
 * OAuth app is saved yet.
 */
export const Unsaved = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      linearOauthAppHandler({
        globalLinearOauthConfigured: false,
        oauthAppSaved: false,
      }),
    )
  },
})

/**
 * Linear setup step where the admin registers a private Linear OAuth app: the
 * OAuth app is already saved.
 */
export const Saved = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      linearOauthAppHandler({
        globalLinearOauthConfigured: false,
        oauthAppSaved: true,
        oauthClientId: "lin_client",
      }),
    )
  },
})
