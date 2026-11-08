import type { Meta, StoryObj } from "@storybook/react-vite"

import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { OAuthOrganizationSelector } from "./OAuthOrganizationSelector"

const meta = {
  title: "Components/Auth/OAuth Organization Selector",
  component: OAuthOrganizationSelector,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof OAuthOrganizationSelector>

export default meta

type Story = StoryObj<typeof meta>

export const MultipleOrganizations: Story = {
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
}
