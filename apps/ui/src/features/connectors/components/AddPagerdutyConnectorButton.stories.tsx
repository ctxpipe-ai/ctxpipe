import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"
import { AddPagerdutyConnectorButton } from "./AddPagerdutyConnectorButton"

const meta = {
  title: "Components/Connections/PagerDuty/AddConnectorButton",
  component: AddPagerdutyConnectorButton,
  parameters: { layout: "centered" },
  args: { onStart: fn() },
  decorators: [
    (Story) => (
      <div className="w-[min(32rem,90vw)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AddPagerdutyConnectorButton>

export default meta

type Story = StoryObj<typeof meta>

export const Available: Story = {}
