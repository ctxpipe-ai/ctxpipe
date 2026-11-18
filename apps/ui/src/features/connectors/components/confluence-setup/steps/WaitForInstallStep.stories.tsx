import type { Meta, StoryObj } from "@storybook/react-vite"

import { WaitForInstallStep } from "./WaitForInstallStep"

const meta = {
  title: "Components/Connections/Atlassian/Steps/WaitForInstall",
  component: WaitForInstallStep,
  decorators: [
    (Story) => (
      <div className="w-full max-w-md p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof WaitForInstallStep>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Wait step of the Confluence setup wizard, without the wizard frame: the user
 * opened the Forge install, and the teal loader waits until Atlassian confirms
 * it.
 */
export const WaitForInstall: Story = {
  parameters: {
    review: {
      kind: "component",
    },
  },
  render: () => <WaitForInstallStep />,
}
