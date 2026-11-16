import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, within } from "storybook/test"

import { OnboardingHowItWorksSlide } from "@/components/onboarding/OnboardingHowItWorksSlide"
import { OnboardingPageShell } from "@/components/onboarding/OnboardingPageShell"

import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"

// The onboarding page story (Pages/Onboarding) owns the frame with a loaded
// scene. This file has only the state that the page story cannot reach: the
// background scene failed to load. The frame always holds a real slide.
const meta = {
  title: "Components/Onboarding/PageShell",
  component: OnboardingPageShell,
  decorators: [...entryPageInnerDecorators],
  parameters: {
    layout: "fullscreen",
    storyRoute: { pattern: "flat", path: "/onboarding" },
    review: { kind: "page" },
  },
  args: {
    sceneReady: true,
    onSceneLoad: fn(),
    onSceneError: fn(),
    children: <OnboardingHowItWorksSlide actionLabel="Next" onNext={fn()} />,
  },
} satisfies Meta<typeof OnboardingPageShell>

export default meta

type Story = StoryObj<typeof meta>

export const SceneFailed: Story = {
  parameters: {
    review: {
      purpose:
        "Onboarding page with the welcome slide: the background scene failed to load, so a note says that Continue still works.",
    },
  },
  args: {
    sceneFailed: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const signOut = await canvas.findByRole("link", { name: "Sign out" })
    expect(signOut).toHaveAttribute("href", "/.auth/sign-out")
    await canvas.findByText("Animation failed to load. Continue still works.")
  },
}
