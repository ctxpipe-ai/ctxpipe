import { expect, fn, within } from "storybook/test"

import { OnboardingHowItWorksSlide } from "@/components/onboarding/OnboardingHowItWorksSlide"
import { OnboardingPageShell } from "@/components/onboarding/OnboardingPageShell"

import preview from "../../../.storybook/preview"

// The onboarding page story (Pages/Onboarding) owns the frame with a loaded
// scene. This file has only the state that the page story cannot reach: the
// background scene failed to load. The frame always holds a real slide.
const meta = preview.meta({
  title: "Components/Onboarding/PageShell",
  component: OnboardingPageShell,
  parameters: {
    layout: "fullscreen",
    review: { kind: "page" },
  },
  args: {
    sceneReady: true,
    onSceneLoad: fn(),
    onSceneError: fn(),
    children: <OnboardingHowItWorksSlide actionLabel="Next" onNext={fn()} />,
  },
})

/**
 * Onboarding page with the welcome slide: the background scene failed to load,
 * so a note says that Continue still works.
 */
export const SceneFailed = meta.story({
  args: {
    sceneFailed: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const signOut = await canvas.findByRole("link", { name: "Sign out" })
    expect(signOut).toHaveAttribute("href", "/.auth/sign-out")
    await canvas.findByText("Animation failed to load. Continue still works.")
  },
})
