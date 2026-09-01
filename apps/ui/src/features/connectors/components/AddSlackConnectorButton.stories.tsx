import type { Meta, StoryObj } from "@storybook/react-vite"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { AddSlackConnectorButton } from "./AddSlackConnectorButton"

const orgSlug = "acme"

const meta = {
  title: "Components/Connections/Slack/AddButton",
  component: AddSlackConnectorButton,
  decorators: [
    (Story) => (
      <div className="w-[min(100vw,24rem)]">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof AddSlackConnectorButton>

export default meta

type Story = StoryObj<typeof meta>

export const CatalogRow: Story = {
  render: () => (
    <AddSlackConnectorButton orgSlug={orgSlug} onOpenSetup={() => {}} />
  ),
}
