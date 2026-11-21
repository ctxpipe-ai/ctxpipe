import preview from "../../../../../../.storybook/preview"
import { WaitForInstallStep } from "./WaitForInstallStep"

const meta = preview.meta({
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
})

/**
 * Wait step of the Confluence setup wizard, without the wizard frame: the user
 * opened the Forge install, and the teal loader waits until Atlassian confirms
 * it.
 */
export const WaitForInstall = meta.story({
  parameters: {
    review: {
      kind: "component",
    },
  },
  render: () => <WaitForInstallStep />,
})
