import type { Meta, StoryObj } from "@storybook/react-vite"
import { WaitForInstallStep } from "./WaitForInstallStep"

const meta = {
  title: "Components/Connections/Atlassian/Steps/WaitForInstall",
  component: WaitForInstallStep,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof WaitForInstallStep>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="w-full max-w-md p-2">
      <WaitForInstallStep />
    </div>
  ),
}
