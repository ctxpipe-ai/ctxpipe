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
    expect(canvas.getByText("Here's how it works.")).toBeVisible()
    // One heading: the title. The subtitle is plain text.
    expect(canvas.getAllByRole("heading")).toHaveLength(1)
    for (const title of STEP_TITLES)
      await waitFor(() => expect(canvas.getByText(title)).toBeVisible())
    await userEvent.click(canvas.getByRole("button", { name: "Next" }))
    await expect(args.onNext).toHaveBeenCalledTimes(1)
  },
}

/**
 * The rows fade in one after another: each row has the short fade (100 ms),
 * and each row starts after the row above it. The last delay is 150 ms at
 * most.
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
        0.1,
      )
      return Number.parseFloat(style.animationDelay)
    })
    // The title starts at once; each row starts after the row above it,
    // and the action row starts after step 3.
    expect(delays).toEqual([0, 0.03, 0.06, 0.09, 0.12])
    for (const row of rows) await waitFor(() => expect(row).toBeVisible())
  },
}

/**
 * With reduced motion, the global rule makes each animation last no time.
 * Each row shows when its short delay ends, and it does not move.
 */
export const RowsWithReducedMotion: Story = {
  tags: ["reduced-motion"],
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("heading", {
      name: "Welcome to ctx|",
    })
    for (const row of slideRows(canvasElement)) {
      expect(
        Number.parseFloat(getComputedStyle(row).animationDuration),
      ).toBeLessThan(0.001)
      await waitFor(() => expect(row).toBeVisible())
    }
  },
}

/** A joiner finishes onboarding from this slide. */
export const Joiner: Story = {
  args: { actionLabel: "Get started" },
}
