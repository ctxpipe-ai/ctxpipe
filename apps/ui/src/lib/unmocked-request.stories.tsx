import type { Meta, StoryObj } from "@storybook/react-vite"
import { ws } from "msw"
import { expect } from "storybook/test"

// A request that no MSW handler answers fails the story (the storybook
// skill, "Mock every request"). The preview (.storybook/preview.tsx) records
// the request and fails it with a network error. The play runner
// (scripts/ci/storybook-play.mjs) reads the record when the story ends and
// fails the story.
//
// This play proves the preview part in the real browser: an API request
// with no handler is recorded and does not reach the network, and a static
// asset goes to the network. A WebSocket that no handler matches is recorded
// and closed, also when the story mocks another socket. At the end the play
// empties the record, so the story itself passes. Storybook reads stories
// from src only, so this story is in src/lib with the other Testing stories
// (play-host).

type UnhandledWindow = Window & { __ctxpipeUnhandledRequests?: string[] }

const meta = {
  title: "Testing/Unmocked request",
  render: () => <p>A request with no mock fails the story.</p>,
  parameters: { review: { kind: "component" } },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/**
 * Test fixture that proves a request with no mock fails: one line of text, and
 * the play sends the requests.
 */
export const RequestWithNoMockFails: Story = {
  parameters: {
    msw: {
      handlers: {
        // An unrelated socket mock: MSW then gives each socket to the `ws`
        // handlers and does not call `onUnhandledRequest` for it.
        socket: [
          ws
            .link(/\/api\/v1\/other-socket$/)
            .addEventListener("connection", () => {}),
        ],
      },
    },
    visual: {
      skip: "Behavior test: it ends on a test fixture, which the product does not render.",
    },
  },
  play: async () => {
    const record = (window as UnhandledWindow).__ctxpipeUnhandledRequests
    await expect(record).toEqual([])
    const url = `${window.location.origin}/acme/api/v1/no-mock.md`
    // The request never reaches the server: it fails at once.
    await expect(fetch(url)).rejects.toThrow()
    await expect(record).toEqual([`GET ${url}`])
    // A static asset of the Storybook server is not a request to mock.
    const font = await fetch("/fonts/Geist-Variable.woff2")
    await expect(font.ok).toBe(true)
    await expect(record).toHaveLength(1)
    // A socket that no handler matches is recorded and closed with an error.
    const socketUrl = `${window.location.origin.replace(/^http/, "ws")}/acme/api/v1/no-mock-socket`
    const closed = await new Promise<CloseEvent>((resolve) => {
      new WebSocket(socketUrl).addEventListener("close", resolve)
    })
    await expect(closed.code).toBe(1011)
    await expect(record).toEqual([`GET ${url}`, `WS ${socketUrl}`])
    record?.splice(0)
  },
}
