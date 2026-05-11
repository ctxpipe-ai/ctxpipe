import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { OnboardingPageShell } from "@/components/onboarding/OnboardingPageShell"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"

function ShellChildren() {
  return (
    <div className="rounded-none border border-border bg-zinc-950/80 px-6 py-12 text-zinc-200">
      <p className="text-lg">Slide placeholder</p>
    </div>
  )
}

const meta = {
  title: "Components/Onboarding/PageShell",
  component: OnboardingPageShell,
  decorators: [...entryPageInnerDecorators],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    currentSlide: 1,
    slideCount: 4,
    onSceneLoad: fn(),
    onSceneError: fn(),
    onGoToSlide: fn(),
    children: <ShellChildren />,
  },
} satisfies Meta<typeof OnboardingPageShell>

export default meta

type Story = StoryObj<typeof meta>

export const DotNavHidden: Story = {
  args: {
    completing: false,
    transitioning: false,
    showDotNav: false,
    sceneFailed: false,
  },
}

export const DotNavVisible: Story = {
  args: {
    completing: false,
    transitioning: false,
    showDotNav: true,
    sceneFailed: false,
  },
}

export const Transitioning: Story = {
  args: {
    completing: false,
    transitioning: true,
    showDotNav: true,
    sceneFailed: false,
  },
}

export const Completing: Story = {
  args: {
    completing: true,
    transitioning: false,
    showDotNav: true,
    sceneFailed: false,
  },
}

export const SceneFailed: Story = {
  args: {
    completing: false,
    transitioning: false,
    showDotNav: true,
    sceneFailed: true,
  },
}

export const CarouselDotsInteraction: Story = {
  args: {
    completing: false,
    transitioning: false,
    showDotNav: true,
    sceneFailed: false,
    slideCount: 3,
    currentSlide: 0,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const goToSlide2 = await canvas.findByRole("button", {
      name: /go to slide 2/i,
    })
    await userEvent.click(goToSlide2)
    expect(args.onGoToSlide).toHaveBeenCalledWith(1)
  },
}
