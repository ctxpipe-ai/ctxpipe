import type { Meta, StoryObj } from "@storybook/react-vite"
import { ConnectorsEmptyState } from "./ConnectorsEmptyState"

const meta = {
  title: "Components/Connections/ConnectorsEmptyState",
  component: ConnectorsEmptyState,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof ConnectorsEmptyState>

export default meta

type Story = StoryObj<typeof meta>

export const Empty: Story = {
  render: () => (
    <div className="w-full max-w-lg">
      <ConnectorsEmptyState onAddConnection={() => {}} />
    </div>
  ),
}
