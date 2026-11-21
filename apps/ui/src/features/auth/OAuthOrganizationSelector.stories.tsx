import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import { OAuthOrganizationSelector } from "./OAuthOrganizationSelector"

const meta = preview.meta({
  title: "Components/Auth/OAuth Organization Selector",
  component: OAuthOrganizationSelector,
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers)
  },
  parameters: {
    app: "root",
    layout: "fullscreen",
    review: { kind: "page" },
  },
})

/**
 * OAuth screen where a user picks the organization that a client connection
 * uses: the user has two organizations.
 */
export const MultipleOrganizations = meta.story({
  name: "Multiple organizations",
  parameters: {
    // The decorators need a router; the page lives at this path.
    storyRoute: {
      pattern: "flat",
      path: "/.auth/select-organization",
    } satisfies StoryRouteParams,
  },
  args: {
    organizations: [
      { id: "org_acme", name: "Acme Engineering", slug: "acme" },
      {
        id: "org_consulting",
        name: "Peterson Advisory",
        slug: "peterson-advisory",
      },
    ],
    onContinue: () => undefined,
  },
})
