import type { Meta, StoryObj } from "@storybook/react-vite"
import { OnboardingJoinerDoneSlide } from "@/components/onboarding/OnboardingJoinerDoneSlide"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"

const meta = {
  title: "Components/Onboarding/Slides/JoinerDone",
  component: OnboardingJoinerDoneSlide,
  decorators: [
    (Story) => (
      <div className="max-w-xl rounded-none border border-border bg-zinc-950 p-8 text-left">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof OnboardingJoinerDoneSlide>

export default meta

type Story = StoryObj<typeof meta>

export const Ready: Story = {
  args: {
    completing: false,
    onFinish: async () => {},
  },
}

export const Completing: Story = {
  args: {
    completing: true,
    onFinish: async () => {},
  },
}
