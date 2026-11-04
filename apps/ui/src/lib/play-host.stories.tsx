import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"

// The play runner (scripts/ci/storybook-play.mjs) pins the time zone, the
// locale, the pixel ratio and the device that a story can read. Thus a play
// gives the same result on a laptop and in CI, and a result cache can reuse
// it across platforms. This play proves the pins in the real browser. In a
// Storybook that the runner did not open, the pins do not apply, so the play
// checks nothing there.
const meta = {
  title: "Testing/Play host",
  render: () => <p>The play runner pins the host values of this page.</p>,
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const PinnedHost: Story = {
  play: async () => {
    const page = window as Window & { __CTXPIPE_GOLDEN__?: unknown }
    if (!page.__CTXPIPE_GOLDEN__) return
    const device = navigator as Navigator & { deviceMemory?: number }
    await expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC")
    await expect(navigator.language).toBe("en-US")
    await expect(window.devicePixelRatio).toBe(1)
    await expect(navigator.hardwareConcurrency).toBe(4)
    await expect(device.deviceMemory).toBe(4)
  },
}
