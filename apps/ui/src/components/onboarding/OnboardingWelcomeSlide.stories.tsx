import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, waitFor, within } from "storybook/test"
import { OnboardingWelcomeSlide } from "@/components/onboarding/OnboardingWelcomeSlide"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"

const meta = {
  title: "Components/Onboarding/Slides/Welcome",
  component: OnboardingWelcomeSlide,
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
  args: {
    onGetStarted: fn(),
    onWelcomeDetailsVisible: fn(),
  },
} satisfies Meta<typeof OnboardingWelcomeSlide>

export default meta

type Story = StoryObj<typeof meta>

export const WelcomeAnimation: Story = {}

export const FullyRevealed: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(
      async () =>
        expect(
          canvas.getByRole("button", { name: /get started/i }),
        ).toBeVisible(),
      { timeout: 4000 },
    )
    expect(args.onWelcomeDetailsVisible).toHaveBeenCalled()
  },
}
