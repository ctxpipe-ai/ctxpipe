import type { Meta, StoryObj } from "@storybook/react-vite"
import { CONFLUENCE_CARD_STEP_DEFS } from "../confluence-setup-model"
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
      currentIndex={CONFLUENCE_CARD_STEP_DEFS.length}
    />
  ),
}

export const RevisitWithFocus: Story = {
  name: "RevisitWithFocus",
  render: () => (
    <ConfluenceStepper
      className="max-w-sm"
      currentIndex={3}
      focusOverride={1}
      onStepSelect={() => {}}
    />
  ),
}
