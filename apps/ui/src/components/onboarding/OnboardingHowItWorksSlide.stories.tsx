import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { OnboardingHowItWorksSlide } from "@/components/onboarding/OnboardingHowItWorksSlide"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"

const meta = {
  title: "Components/Onboarding/Slides/HowItWorks",
  component: OnboardingHowItWorksSlide,
  decorators: [
    (Story) => (
      <div className="max-w-2xl rounded-md border border-border bg-zinc-950 p-8 text-center">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "flat",
      path: "/onboarding",
    } satisfies StoryRouteParams,
  },
  args: {
    actionLabel: "Next",
    onNext: fn(),
  },
} satisfies Meta<typeof OnboardingHowItWorksSlide>

export default meta

type Story = StoryObj<typeof meta>

export const NewOrganization: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() => expect(canvas.getByText("A Workspace")).toBeVisible())
    expect(canvas.getByText("Kept current")).toBeVisible()
    expect(canvas.getByText("An agent that works in it")).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Next" }))
    await expect(args.onNext).toHaveBeenCalledTimes(1)
  },
}

/** A joiner finishes onboarding from this slide. */
export const Joiner: Story = {
  args: { actionLabel: "Get started" },
}
