import type { Meta, StoryObj } from "@storybook/react-vite"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import { OAuthConsent } from "./OAuthConsent"

const meta = {
  title: "Components/Auth/OAuth Consent",
  component: OAuthConsent,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof OAuthConsent>

export default meta

type Story = StoryObj<typeof meta>

export const BoundOrganization: Story = {
  name: "Bound organisation",
  args: {
    clientId: "claude-plugin",
    scopes: ["openid", "offline_access"],
    organization: {
      name: "Peterson Advisory",
      slug: "peterson-advisory",
    },
    changeOrganizationHref:
      "/.auth/select-organization?client_id=claude-plugin&sig=abc.def",
    onAllow: () => undefined,
    onDeny: () => undefined,
  },
}
