import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { Skeleton } from "./Skeleton"
import { Spinner } from "./spinner"

const meta = {
  title: "Components/Loading indicators",
  parameters: {
    layout: "centered",
    review: { kind: "component" },
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
 * Spinner and skeleton that show a load in progress: the user
 * prefers reduced motion, and each one still loops. The play runner opens this
 * story with `prefers-reduced-motion: reduce` (DESIGN.md "Motion").
 */
export const LoadingUnderReducedMotion: Story = {
  parameters: {
    intent:
      "Catches loading indicators that stop looping when the user prefers reduced motion. The spinner and the skeleton must keep a visible loop. Not for color or size.",
  },
  tags: ["required", "reduced-motion"],
  render: () => (
    <div className="flex w-64 flex-col gap-4">
      <Spinner />
      <Skeleton data-testid="skeleton" className="h-4 w-40" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(
      true,
    )
    expectLooping(getComputedStyle(canvas.getByRole("status")))
    expectLooping(getComputedStyle(canvas.getByTestId("skeleton"), "::before"))
  },
}
