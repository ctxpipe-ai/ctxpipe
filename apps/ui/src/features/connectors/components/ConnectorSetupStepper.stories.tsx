import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  MANAGED_CONFLUENCE_WIZARD_STEPS,
  SELF_HOSTED_CONFLUENCE_WIZARD_STEPS,
} from "../confluence-setup-model"
import { ConnectorSetupStepper } from "./ConnectorSetupStepper"

const meta = {
  title: "Components/Connections/SetupStepper",
  component: ConnectorSetupStepper,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof ConnectorSetupStepper>

export default meta

type Story = StoryObj<typeof meta>

export const MidFlow: Story = {
  render: () => (
    <ConnectorSetupStepper
      className="max-w-sm"
      steps={MANAGED_CONFLUENCE_WIZARD_STEPS}
      currentIndex={2}
      onStepSelect={() => {}}
    />
  ),
}

export const AllComplete: Story = {
  render: () => (
    <ConnectorSetupStepper
      className="max-w-sm"
      steps={MANAGED_CONFLUENCE_WIZARD_STEPS}
      currentIndex={MANAGED_CONFLUENCE_WIZARD_STEPS.length}
    />
  ),
}

export const RevisitWithFocus: Story = {
  render: () => (
    <ConnectorSetupStepper
      className="max-w-sm"
      steps={MANAGED_CONFLUENCE_WIZARD_STEPS}
      currentIndex={3}
      focusOverride={1}
      onStepSelect={() => {}}
    />
  ),
}

/** Extra “Register OAuth” row for self-hosted deployments. */
export const SelfHostedCurrentRegister: Story = {
  name: "Self-hosted / register OAuth",
  render: () => (
    <ConnectorSetupStepper
      className="max-w-md"
      steps={SELF_HOSTED_CONFLUENCE_WIZARD_STEPS}
      currentIndex={0}
      onStepSelect={() => {}}
    />
  ),
}
