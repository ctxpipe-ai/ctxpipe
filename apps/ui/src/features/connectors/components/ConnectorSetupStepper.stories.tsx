import type { Meta, StoryObj } from "@storybook/react-vite"
import { ConnectorSetupStepper } from "./ConnectorSetupStepper"

const steps = [
  { id: "connect", label: "Connect workspace" },
  { id: "repository", label: "Select repository" },
  { id: "scope", label: "Configure scope" },
] as const

const meta = {
  title: "Components/Connections/ConnectorSetupStepper",
  component: ConnectorSetupStepper,
  parameters: { layout: "centered" },
  args: { steps, currentIndex: 1 },
} satisfies Meta<typeof ConnectorSetupStepper>

export default meta

type Story = StoryObj<typeof meta>

export const InProgress: Story = {}

export const Complete: Story = {
  args: { currentIndex: steps.length },
}
