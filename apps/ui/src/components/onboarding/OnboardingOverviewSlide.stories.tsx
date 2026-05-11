import type { Meta, StoryObj } from "@storybook/react-vite"
import { OnboardingOverviewSlide } from "@/components/onboarding/OnboardingOverviewSlide"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"

const meta = {
  title: "Components/Onboarding/Slides/Overview",
  component: OnboardingOverviewSlide,
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
} satisfies Meta<typeof OnboardingOverviewSlide>

export default meta

type Story = StoryObj<typeof meta>

export const Overview: Story = {
  args: {
    onNext: () => {},
  },
}
