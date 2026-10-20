import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"
import { ProgressBar } from "./ProgressBar"
import { Skeleton } from "./Skeleton"
import { Spinner } from "./spinner"

const meta = {
  title: "Components/Loading indicators",
  parameters: {
    layout: "centered",
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

function expectLooping(style: CSSStyleDeclaration) {
  expect(style.animationName).not.toBe("none")
  expect(style.animationIterationCount).toBe("infinite")
  expect(Number.parseFloat(style.animationDuration)).toBeGreaterThan(0.1)
}

/**
 * The golden runner opens this story with `prefers-reduced-motion: reduce`.
 * Loading indicators must keep showing progress (DESIGN.md "Motion").
 */
export const LoadingUnderReducedMotion: Story = {
  tags: ["workspace-golden", "reduced-motion"],
  render: () => (
    <div className="flex w-64 flex-col gap-4">
      <Spinner />
      <ProgressBar aria-label="Loading" isIndeterminate />
      <Skeleton data-testid="skeleton" className="h-4 w-40" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(
      true,
    )
    expectLooping(getComputedStyle(canvas.getByRole("status")))
    const bar = canvas
      .getByRole("progressbar")
      .querySelector<HTMLElement>('[class*="repeat-infinite"]')
    expect(bar).not.toBeNull()
    expectLooping(getComputedStyle(bar as HTMLElement))
    expectLooping(getComputedStyle(canvas.getByTestId("skeleton"), "::before"))
  },
}
