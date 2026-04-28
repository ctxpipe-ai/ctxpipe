import type { Meta, StoryObj } from "@storybook/react-vite"
import { entryPageInnerDecorators } from "../../../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../../../.storybook/decorators/with-story-route"
import { SetupCompleteStep } from "./SetupCompleteStep"

const meta = {
  title: "Components/Connections/Atlassian/Steps/SetupComplete",
  component: SetupCompleteStep,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof SetupCompleteStep>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="w-full max-w-md p-2">
      <SetupCompleteStep onClose={() => {}} />
    </div>
  ),
}
