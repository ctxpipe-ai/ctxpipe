import { expect, waitFor, within } from "storybook/test"

/**
 * Story-only wait of a graph play: it ends when the knowledge graph canvas in
 * `root` is ready for the user. The canvas mounts its tool rail ("Reset view")
 * when it shows the graph, at the end of its first layout. A canvas with a
 * timeline also needs the timeline data: until it loads, "Play history" is
 * disabled. Then the wait also ends only when that button is enabled.
 *
 * The time of the layout depends on the CPU, because the screenshot container
 * renders WebGL on the CPU. In 30 runs of each graph play with one CPU and no
 * network (`visual-capture.mjs --cpus 1`), a play with a reduced-motion
 * layout of 300 steps took at most 33 s, and a play with motion at most
 * 16 s (CTX-1437). The bound is about 2x the longest time, and less than
 * the 120 s that the runner gives each story. It is a ceiling, not a delay:
 * the wait ends when the canvas is ready.
 */
export async function waitForGraphReady(root: HTMLElement) {
  const graph = within(root)
  await waitFor(
    async () => {
      graph.getByRole("button", { name: "Reset view" })
      const history = graph.queryByRole("button", { name: "Play history" })
      if (history) await expect(history).toBeEnabled()
    },
    { timeout: 70_000 },
  )
}
