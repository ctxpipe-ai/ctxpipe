import type { Meta, StoryObj } from "@storybook/react-vite"
import { OrgOutletError } from "./OrgOutletError"

const meta = {
  title: "Components/Org/OutletError",
  component: OrgOutletError,
} satisfies Meta<typeof OrgOutletError>

export default meta

type Story = StoryObj<typeof meta>

export const ConnectorsFailed: Story = {
  args: {
    title: "Could not load connectors",
    error: new Error("Failed to load connections"),
    reset: () => undefined,
  },
}
