import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  MANAGED_CONFLUENCE_WIZARD_STEPS,
  SELF_HOSTED_CONFLUENCE_WIZARD_STEPS,
} from "../confluence-setup-model"
import { ConfluenceStepper } from "./ConfluenceStepper"

const meta = {
  title: "Components/Connections/Atlassian/ConfluenceStepper",
  component: ConfluenceStepper,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof ConfluenceStepper>

export default meta

type Story = StoryObj<typeof meta>

export const MidFlow: Story = {
  name: "MidFlow",
  render: () => (
    <ConfluenceStepper
      className="max-w-sm"
      steps={MANAGED_CONFLUENCE_WIZARD_STEPS}
      currentIndex={2}
      onStepSelect={() => {}}
    />
  ),
}

export const AllComplete: Story = {
  name: "AllComplete",
  render: () => (
    <ConfluenceStepper
      className="max-w-sm"
      steps={MANAGED_CONFLUENCE_WIZARD_STEPS}
      currentIndex={MANAGED_CONFLUENCE_WIZARD_STEPS.length}
    />
  ),
}

export const RevisitWithFocus: Story = {
  name: "RevisitWithFocus",
  render: () => (
    <ConfluenceStepper
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
  name: "SelfHosted / current at register OAuth",
  render: () => (
    <ConfluenceStepper
      className="max-w-md"
      steps={SELF_HOSTED_CONFLUENCE_WIZARD_STEPS}
      currentIndex={0}
      onStepSelect={() => {}}
    />
  ),
}
