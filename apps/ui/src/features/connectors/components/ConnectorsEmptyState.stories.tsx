import preview from "../../../../.storybook/preview"
import { ConnectorsEmptyState } from "./ConnectorsEmptyState"

const meta = preview.meta({
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
})

/**
 * Empty state of the Connectors list, which invites the user to add a
 * connection: the org has no connections yet.
 */
export const EmptyState = meta.story({
  parameters: {
    review: { kind: "component" },
  },
  args: { onAddConnection: () => {} },
  render: (args) => <ConnectorsEmptyState {...args} />,
})
