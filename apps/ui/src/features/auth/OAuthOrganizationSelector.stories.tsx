import type { Meta, StoryObj } from "@storybook/react-vite"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import { OAuthOrganizationSelector } from "./OAuthOrganizationSelector"

const meta = {
  title: "Components/Auth/OAuth Organisation Selector",
  component: OAuthOrganizationSelector,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof OAuthOrganizationSelector>

export default meta

type Story = StoryObj<typeof meta>

export const MultipleOrganizations: Story = {
  name: "Multiple organisations",
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
