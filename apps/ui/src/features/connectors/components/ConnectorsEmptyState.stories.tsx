import type { Meta, StoryObj } from "@storybook/react-vite"

import { ConnectorsEmptyState } from "./ConnectorsEmptyState"

const meta = {
  title: "Components/Connections/EmptyState",
  component: ConnectorsEmptyState,
  decorators: [
    (Story) => (
      <div className="w-full max-w-lg">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof ConnectorsEmptyState>

export default meta

type Story = StoryObj<typeof meta>

export const EmptyState: Story = {
  parameters: {
    review: {
      kind: "component",
      purpose:
        "Empty state of the Connectors list, which invites the user to add a connection: the org has no connections yet.",
    },
  },
  args: { onAddConnection: () => {} },
  render: (args) => <ConnectorsEmptyState {...args} />,
}
