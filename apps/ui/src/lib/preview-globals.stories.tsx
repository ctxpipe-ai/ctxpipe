import type { Meta, StoryObj } from "@storybook/react-vite"
import { QueryClientContext } from "@tanstack/react-query"
import { WebSocketHandler } from "msw"
import { useContext } from "react"
import { expect } from "storybook/test"

// The globals of the preview (.storybook/preview.tsx) add no mock, add
// nothing to the DOM and change no behavior that a story sees (the storybook
// skill, "No globals"). Each global decorator is a no-op until the story file
// sets its parameter. scripts/ci/check-storybook-globals.mjs reads the
// source; this play proves the result in the real browser.

function QueryClientProbe() {
  const queryClient = useContext(QueryClientContext) ? "yes" : "no"
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

/**
 * Test fixture that proves the globals of the preview add nothing: one line of
 * text, with no wrapper, no Query client and no mock.
 */
export const NoOptIn: Story = {
  play: async ({ canvasElement, msw }) => {
    // The story element is the only child of the root: no global wrapper.
    await expect(canvasElement.children).toHaveLength(1)
    const probe = canvasElement.firstElementChild
    await expect(probe?.tagName).toBe("P")
    await expect(probe).toHaveAttribute("data-query-client", "no")
    // The only handler of the worker is the socket handler that fails an
    // unmatched socket (it answers no socket). MSW adds to each `ws.link`
    // handler an HTTP handler with a predicate: it answers only the upgrade
    // request of a socket, which a browser page cannot send.
    const handlers = msw.listHandlers()
    await expect(
      handlers.filter((handler) => handler instanceof WebSocketHandler),
    ).toHaveLength(1)
    await expect(
      handlers.flatMap((handler) =>
        handler instanceof WebSocketHandler ? [] : [handler.info.header],
      ),
    ).toEqual(["GET [custom predicate]"])
  },
}

/**
 * Test fixture that proves the opt-in of the Query client: one line of text,
 * and the story file sets parameters.queryClient.
 */
export const QueryClientOptIn: Story = {
  parameters: {
    queryClient: true,
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.firstElementChild).toHaveAttribute(
      "data-query-client",
      "yes",
    )
  },
}
