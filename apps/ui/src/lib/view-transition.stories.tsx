import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { useRevealOnce } from "./useRevealOnce"

let second: ViewTransition | null = null

/**
 * The block shows through `useRevealOnce`. Right after the hook starts its
 * view transition, a second transition starts, as the Home notices do when a
 * toast goes while the guide still appears.
 */
function RevealThenSkip() {
  const [ready, setReady] = useState(false)
  const shown = useRevealOnce(ready)
  // This effect runs after the effect of the hook, in the same commit.
  useEffect(() => {
    if (ready) second = document.startViewTransition(() => {})
  }, [ready])
  return (
    <div className="p-6">
      <button type="button" onClick={() => setReady(true)}>
        Reveal
      </button>
      {shown ? <p>Revealed block</p> : null}
    </div>
  )
}

const meta = {
  title: "Lib/View transitions",
  render: () => <RevealThenSkip />,
  beforeEach: () => {
    second = null
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

/**
 * Test block that reveals content with a view transition: the user pressed
 * Reveal, and the block shows. A later transition skips the one of
 * `useRevealOnce`, and the AbortError of its `ready` promise must not become an
 * unhandled rejection.
 */
export const SkippedTransitionRejectsNothingUnhandled: Story = {
  parameters: {
    review: {
      kind: "component",
    },
  },
  play: async ({ canvasElement }) => {
    expect(typeof document.startViewTransition).toBe("function")
    const unhandled: string[] = []
    const onRejection = (event: PromiseRejectionEvent) =>
      unhandled.push(String(event.reason))
    window.addEventListener("unhandledrejection", onRejection)
    try {
      await userEvent.click(
        within(canvasElement).getByRole("button", { name: "Reveal" }),
      )
      await waitFor(() => expect(second).not.toBeNull())
      await second?.finished
      // The browser reports an unhandled rejection after the task that
      // rejected the promise. One more task makes sure it came.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(within(canvasElement).getByText("Revealed block")).toBeVisible()
      expect(unhandled).toEqual([])
    } finally {
      window.removeEventListener("unhandledrejection", onRejection)
    }
  },
}
