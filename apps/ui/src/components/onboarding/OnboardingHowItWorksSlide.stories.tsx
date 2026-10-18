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

const STEP_TITLES = [
  "Your team's knowledge, in git",
  "Kept current",
  "Ready for your agents",
]

/** The rows of the slide, top to bottom: the title, three steps, the action. */
function slideRows(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  const welcome = canvas.getByRole("heading", { name: "Welcome to ctx|" })
  const steps = STEP_TITLES.map(
    (title) => canvas.getByText(title).closest("li") as HTMLElement,
  )
  const action = canvas.getByText(
    "Turn ctx| off, and your knowledge stays in your repository.",
  ).parentElement as HTMLElement
  return [welcome.parentElement as HTMLElement, ...steps, action]
}

export const NewOrganization: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { level: 1, name: "Welcome to ctx|" }),
      ).toBeVisible(),
    )
    expect(
      canvas.getByRole("heading", { level: 2, name: "Here's how it works." }),
    ).toBeVisible()
    for (const title of STEP_TITLES)
      await waitFor(() => expect(canvas.getByText(title)).toBeVisible())
    await userEvent.click(canvas.getByRole("button", { name: "Next" }))
    await expect(args.onNext).toHaveBeenCalledTimes(1)
  },
}

/**
 * The rows fade in one after another: each row has the short fade, and each
 * row starts later than the row above it, by 150 ms at most.
 */
export const RowsFadeInInOrder: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("heading", {
      name: "Welcome to ctx|",
    })
    const rows = slideRows(canvasElement)
    const delays = rows.map((row) => {
      const style = getComputedStyle(row)
      expect(style.animationName).toBe("enter")
      expect(Number.parseFloat(style.animationDuration)).toBeLessThanOrEqual(
        0.15,
      )
      return Number.parseFloat(style.animationDelay)
    })
    // The title starts at once; each step starts after the row above it.
    expect(delays.slice(0, 4)).toEqual([0, 0.05, 0.1, 0.15])
    expect(delays[4]).toBeLessThanOrEqual(0.15)
    for (const row of rows) await waitFor(() => expect(row).toBeVisible())
  },
}

/** With reduced motion, the rows have no animation and show at once. */
export const RowsWithReducedMotion: Story = {
  tags: ["reduced-motion"],
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("heading", {
      name: "Welcome to ctx|",
    })
    for (const row of slideRows(canvasElement)) {
      const style = getComputedStyle(row)
      expect(style.animationName).toBe("none")
      expect(style.opacity).toBe("1")
    }
  },
}

/** A joiner finishes onboarding from this slide. */
export const Joiner: Story = {
  args: { actionLabel: "Get started" },
}
