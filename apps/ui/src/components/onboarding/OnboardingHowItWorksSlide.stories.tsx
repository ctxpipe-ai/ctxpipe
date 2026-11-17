import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { OnboardingHowItWorksSlide } from "@/components/onboarding/OnboardingHowItWorksSlide"

const meta = {
  title: "Components/Onboarding/Slides/HowItWorks",
  component: OnboardingHowItWorksSlide,
  decorators: [
    (Story) => (
      <div className="max-w-3xl rounded-md border border-border bg-zinc-950 p-8 text-center">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "centered",
    review: { kind: "component" },
  },
  args: {
    actionLabel: "Next",
    onNext: fn(),
  },
} satisfies Meta<typeof OnboardingHowItWorksSlide>

export default meta

type Story = StoryObj<typeof meta>

const STEP_TITLES = [
  "Link your code and tools. ctxpipe keeps them current as Markdown in your git.",
  "Review every change, and edit the files like any git repository.",
  "Point every agent at the same facts over MCP.",
]

const WELCOME_TITLE = "Welcome to ctxpipe"

/** The rows of the slide, top to bottom: the title, three steps, the action. */
function slideRows(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  const welcome = canvas.getByRole("heading", { name: WELCOME_TITLE })
  const steps = STEP_TITLES.map(
    (title) => canvas.getByText(title).closest("li") as HTMLElement,
  )
  const action = canvas.getByRole("button").parentElement as HTMLElement
  return [welcome.parentElement as HTMLElement, ...steps, action]
}

/**
 * Welcome slide of onboarding, which tells a new user how ctxpipe works in
 * three steps: a user with no org pressed Next, which opens the step that
 * creates the org.
 */
export const NewOrganization: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { level: 1, name: WELCOME_TITLE }),
      ).toBeVisible(),
    )
    expect(
      canvas.getByText("Context management for your software factory."),
    ).toBeVisible()
    // One heading: the title. The subtitle and the step labels are plain text.
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
  parameters: {
    review: {
      purpose:
        "Welcome slide of onboarding that explains how ctxpipe works in three steps: the rows faded in one after another.",
    },
  },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("heading", {
      name: WELCOME_TITLE,
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
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as RowsFadeInInOrder.",
    },
    review: {
      purpose:
        "Welcome slide of onboarding that explains how ctxpipe works in three steps: the user prefers reduced motion, so the rows do not move.",
    },
  },
  tags: ["reduced-motion"],
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("heading", {
      name: WELCOME_TITLE,
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
  parameters: {
    review: {
      purpose:
        "Welcome slide of onboarding, which tells a new user how ctxpipe works in three steps: a user who joined an org reads it, and Get started opens Home.",
    },
  },
  args: { actionLabel: "Get started" },
}
