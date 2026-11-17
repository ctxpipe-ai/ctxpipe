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
    review: { kind: "component" },
  },
} satisfies Meta<typeof ConnectorSetupStepper>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Step list at the top of the Confluence setup wizard: the first two steps are
 * done, and the user works on the third step, Add to Workspaces.
 */
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

/**
 * Step list of the Confluence connector setup, which shows progress through the
 * setup: all steps are complete.
 */
export const AllComplete: Story = {
  render: () => (
    <ConnectorSetupStepper
      className="max-w-sm"
      steps={MANAGED_CONFLUENCE_WIZARD_STEPS}
      currentIndex={MANAGED_CONFLUENCE_WIZARD_STEPS.length}
    />
  ),
}

/**
 * Step list of the Confluence connector setup, which shows progress through the
 * setup: the user is on step four and revisits step two.
 */
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

/**
 * Step list of the Confluence connector setup for a self-hosted deployment,
 * which has an extra Register OAuth step: the user is on that first step,
 * register the OAuth app.
 */
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
