import type { Meta, StoryObj } from "@storybook/react-vite"
import { useQueryClient } from "@tanstack/react-query"
import { getWorker } from "msw-storybook-addon"
import { expect } from "storybook/test"

// The globals of the preview (.storybook/preview.tsx) add no mock, add
// nothing to the DOM and change no behavior that a story sees (the storybook
// skill, "No globals"). Each global decorator is a no-op until the story file
// sets its parameter. scripts/ci/check-storybook-globals.mjs reads the
// source; this play proves the result in the real browser.

function QueryClientProbe() {
  let queryClient = "yes"
  try {
    useQueryClient()
  } catch {
    queryClient = "no"
  }
  return <p data-query-client={queryClient}>A story with no opt-in.</p>
}

const meta = {
  title: "Testing/Preview globals",
  render: () => <QueryClientProbe />,
  parameters: {
    review: { kind: "component" },
    visual: {
      skip: "Behavior test: it ends on a test fixture, which the product does not render.",
    },
  },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const NoOptIn: Story = {
  parameters: {
    review: {
      purpose:
        "Test fixture that proves the globals of the preview add nothing: one line of text, with no wrapper, no Query client and no mock.",
    },
  },
  play: async ({ canvasElement }) => {
    // The story element is the only child of the root: no global wrapper.
    await expect(canvasElement.children).toHaveLength(1)
    const probe = canvasElement.firstElementChild
    await expect(probe?.tagName).toBe("P")
    await expect(probe).toHaveAttribute("data-query-client", "no")
    // The only handler of the worker is the socket handler that fails an
    // unmatched socket (it answers no socket).
    await expect(getWorker().listHandlers()).toHaveLength(1)
  },
}

export const QueryClientOptIn: Story = {
  parameters: {
    queryClient: true,
    review: {
      purpose:
        "Test fixture that proves the opt-in of the Query client: one line of text, and the story file sets parameters.queryClient.",
    },
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.firstElementChild).toHaveAttribute(
      "data-query-client",
      "yes",
    )
  },
}
