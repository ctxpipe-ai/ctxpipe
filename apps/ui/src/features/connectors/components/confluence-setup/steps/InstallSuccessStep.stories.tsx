import type { Meta, StoryObj } from "@storybook/react-vite"
import { InstallSuccessStep } from "./InstallSuccessStep"

const meta = {
  title: "Components/Connections/Atlassian/Steps/InstallSuccess",
  component: InstallSuccessStep,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof InstallSuccessStep>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="w-full max-w-md p-2">
      <InstallSuccessStep onContinue={() => {}} />
    </div>
  ),
}
