import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, within } from "storybook/test"
import { OnboardingPageShell } from "@/components/onboarding/OnboardingPageShell"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"

function ShellChildren() {
  return (
    <div className="rounded-md border border-border bg-zinc-950/80 px-6 py-12 text-zinc-200">
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
    sceneReady: true,
    onSceneLoad: fn(),
    onSceneError: fn(),
    children: <ShellChildren />,
  },
} satisfies Meta<typeof OnboardingPageShell>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    sceneFailed: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const signOut = await canvas.findByRole("link", { name: "Sign out" })
    expect(signOut).toHaveAttribute("href", "/.auth/sign-out")
  },
}

export const SceneFailed: Story = {
  args: {
    sceneFailed: true,
  },
}
