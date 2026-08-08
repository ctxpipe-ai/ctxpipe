import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"
import { AddLinearConnectorButton } from "./AddLinearConnectorButton"

const meta = {
  title: "Components/Connections/Linear/AddConnectorButton",
  component: AddLinearConnectorButton,
  parameters: { layout: "centered" },
  args: { onStart: fn() },
  decorators: [
    (Story) => (
      <div className="w-[min(32rem,90vw)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AddLinearConnectorButton>

export default meta

type Story = StoryObj<typeof meta>

export const Available: Story = {}
