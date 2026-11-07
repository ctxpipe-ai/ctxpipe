import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect } from "storybook/test"

// The play runner (scripts/ci/storybook-play.mjs) pins the time zone, the
// locale, the pixel ratio and the device that a story can read. Thus a play
// gives the same result on a laptop and in CI, and a result cache can reuse
// it across platforms. It also pins the values that change a screenshot from
// run to run: the viewport, the origin, the clock and Math.random. When the
// story has ended, it stops the CSS animations and transitions, hides the
// text caret and waits for the web fonts.
//
// This play proves the pins in the real browser: the runner starts the
// browser in another time zone and language, no real host has 3 CPUs and
// 2 GB, and each other pin has a value that the browser does not give by
// itself. The settled page is checked in `afterSettle`, which the runner
// calls after the play. So the story fails when a pin is missing. In a
// Storybook that the runner did not open, the pins do not apply, so the play
// checks nothing there.

// A font that is still loading when the play ends. Its request fails after
// a delay, so the font is not loaded until the runner waits for it.
const lateFont = "/play-host-late-font.woff2"

const meta = {
  title: "Testing/Play host",
  render: () => (
    <>
      <p>The play runner pins the host values of this page.</p>
      <input aria-label="Text with a caret" defaultValue="Caret" />
      <span
        data-testid="spinner"
        className="inline-block animate-spin transition-colors"
      >
        Spinner
      </span>
    </>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(lateFont, async () => {
            await delay(500)
            return new HttpResponse(null, { status: 404 })
          }),
        ],
      },
    },
  },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const PinnedHost: Story = {
  play: async ({ canvas }) => {
    const page = window as Window & {
      __CTXPIPE_PLAY__?: { afterSettle?: () => void }
    }
    const runner = page.__CTXPIPE_PLAY__
    if (!runner) return
    const device = navigator as Navigator & { deviceMemory?: number }
    await expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC")
    await expect(navigator.language).toBe("en-US")
    await expect(window.devicePixelRatio).toBe(1)
    await expect(navigator.hardwareConcurrency).toBe(3)
    await expect(device.deviceMemory).toBe(2)
    await expect([window.innerWidth, window.innerHeight]).toEqual([1440, 900])
    // The real server has a free port; the page sees a fixed origin.
    await expect(window.location.origin).toBe("http://localhost:6006")
    // The clock starts at a fixed time and runs. A play ends in less than a
    // minute.
    const elapsed = Date.now() - Date.parse("2026-11-02T12:00:00Z")
    await expect(elapsed).toBeGreaterThanOrEqual(0)
    await expect(elapsed).toBeLessThan(60_000)
    // The seeded generator replaces the native one.
    await expect(Function.prototype.toString.call(Math.random)).not.toContain(
      "[native code]",
    )
    // Before the page settles, the animation runs.
    const spinner = canvas.getByTestId("spinner")
    await expect(getComputedStyle(spinner).animationName).toBe("spin")
    const font = new FontFace("Play host late", `url(${lateFont})`)
    document.fonts.add(font)
    font.load().catch(() => undefined)
    const input = canvas.getByRole("textbox", { name: "Text with a caret" })
    runner.afterSettle = () => {
      expect(getComputedStyle(spinner).animationName).toBe("none")
      expect(getComputedStyle(spinner).transitionProperty).toBe("none")
      expect(getComputedStyle(input).caretColor).toBe("rgba(0, 0, 0, 0)")
      expect(document.fonts.status).toBe("loaded")
    }
  },
}
