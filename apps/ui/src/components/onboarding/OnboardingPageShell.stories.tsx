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
    storyRoute: { pattern: "flat", path: "/onboarding" },
  },
  args: {
    currentSlide: 1,
    slideCount: 4,
    sceneReady: true,
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
    showDotNav: false,
    sceneFailed: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const signOut = await canvas.findByRole("link", { name: "Sign out" })
    expect(signOut).toHaveAttribute("href", "/.auth/sign-out")
  },
}

export const DotNavVisible: Story = {
  args: {
    showDotNav: true,
    sceneFailed: false,
  },
}

export const RepositoryIndexingStatus: Story = {
  args: {
    showDotNav: true,
    sceneFailed: false,
    statusIndicator: (
      <output className="inline-flex items-center gap-2 border border-teal-400/30 bg-zinc-950/90 px-3 py-2 font-mono text-xs text-teal-100 shadow-lg shadow-black/20 backdrop-blur">
        <span aria-hidden className="ctx-indexing-dot" />
        Indexing 3 repositories
      </output>
    ),
  },
}

export const SceneFailed: Story = {
  args: {
    showDotNav: true,
    sceneFailed: true,
  },
}

export const CarouselDotsInteraction: Story = {
  args: {
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
