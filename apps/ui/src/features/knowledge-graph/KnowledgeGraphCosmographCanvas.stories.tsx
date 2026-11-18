import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import {
  KnowledgeGraphCosmographCanvas,
  type KnowledgeGraphSelectionEvent,
} from "./KnowledgeGraphCosmographCanvas"

// The canvas shows its controls only after the layout settles. That wait is
// bound by CPU, so it is a ceiling, not a delay: a play continues as soon as the
// control mounts. It stays under the 120 s limit of the story runner.
const layoutSettleTimeout = 60_000

const meta = {
  title: "Components/Knowledge Graph/Cosmograph Canvas",
  component: KnowledgeGraphCosmographCanvas,
  decorators: [
    (Story) => (
      <div className="relative h-[min(44rem,100vh)] w-[min(72rem,100vw)] overflow-hidden bg-zinc-950">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen", review: { kind: "component" } },
  args: {
    onPointClick: fn(),
    onBackgroundClick: fn(),
    onSelectionChange: fn(),
    points: [
      {
        id: "auth",
        label: "Authentication",
        kind: "Capability",
        summary: "User identity and access",
        degree: 5,
      },
      {
        id: "api",
        label: "Public API",
        kind: "Service",
        summary: "HTTP application boundary",
        degree: 4,
      },
      {
        id: "worker",
        label: "Ingestion worker",
        kind: "Service",
        summary: "Repository processing",
        degree: 3,
      },
      {
        id: "postgres",
        label: "PostgreSQL",
        kind: "Technology",
        summary: "Primary persistence",
        degree: 3,
      },
      {
        id: "github",
        label: "GitHub",
        kind: "Integration",
        summary: "Repository source",
        degree: 2,
      },
      {
        id: "events",
        label: "Domain events",
        kind: "Pattern",
        summary: "Asynchronous coordination",
        degree: 1,
      },
    ],
    links: [
      {
        source: "api",
        target: "auth",
        predicate: "uses",
        confidence: 0.95,
        lastObservedAt: "2026-07-27T00:00:00.000Z",
        lastObservedAtMs: Date.parse("2026-07-27T00:00:00.000Z"),
      },
      {
        source: "api",
        target: "postgres",
        predicate: "stores data in",
        confidence: 0.9,
        lastObservedAt: "2026-07-25T00:00:00.000Z",
        lastObservedAtMs: Date.parse("2026-07-25T00:00:00.000Z"),
      },
      {
        source: "worker",
        target: "postgres",
        predicate: "stores data in",
        confidence: 0.88,
        lastObservedAt: "2026-07-24T00:00:00.000Z",
        lastObservedAtMs: Date.parse("2026-07-24T00:00:00.000Z"),
      },
      {
        source: "worker",
        target: "github",
        predicate: "reads from",
        confidence: 0.85,
        lastObservedAt: "2026-07-22T00:00:00.000Z",
        lastObservedAtMs: Date.parse("2026-07-22T00:00:00.000Z"),
      },
      {
        source: "worker",
        target: "events",
        predicate: "publishes",
        confidence: 0.72,
        lastObservedAt: "2026-07-20T00:00:00.000Z",
        lastObservedAtMs: Date.parse("2026-07-20T00:00:00.000Z"),
      },
      {
        source: "auth",
        target: "github",
        predicate: "integrates with",
        confidence: 0.68,
        lastObservedAt: "2026-07-18T00:00:00.000Z",
        lastObservedAtMs: Date.parse("2026-07-18T00:00:00.000Z"),
      },
    ],
  },
} satisfies Meta<typeof KnowledgeGraphCosmographCanvas>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Graph canvas of the knowledge graph, where a user explores how the knowledge
 * of a Workspace links: the layout settled, so the controls, the search, the
 * legends and the timeline show.
 */
export const NativeLegends: Story = {
  // The WebGL canvas draws a new frame at each shot, and the cluster labels
  // of Cosmograph move with it. The capture hides both.
  parameters: {
    visual: { masks: ["canvas", ".css-label--labels-container"] },
  },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByLabelText(
      "Search nodes",
      {},
      { timeout: layoutSettleTimeout },
    )
  },
}

/**
 * Graph canvas of the knowledge graph, where a user explores how the files of a
 * Workspace link: the canvas in a narrow pane.
 */
export const PaneNarrow: Story = {
  decorators: [
    (Story) => (
      <div className="relative h-[32rem] w-96 overflow-hidden bg-zinc-950">
        <Story />
      </div>
    ),
  ],
}

/**
 * Graph canvas of the knowledge graph, where a user explores how the files of a
 * Workspace link: the canvas in a wide pane.
 */
export const PaneWide: Story = {
  decorators: [
    (Story) => (
      <div className="relative h-[32rem] w-full max-w-5xl overflow-hidden bg-zinc-950">
        <Story />
      </div>
    ),
  ],
}

/**
 * Graph canvas of the knowledge graph, where a user explores how the files of a
 * Workspace link: the node drawer is open and is the focused layer. The search
 * and the timeline dim and do not take input.
 */
export const DrawerOpenDimsOverlays: Story = {
  args: { drawerOpen: true },
  // The WebGL canvas draws a new frame at each shot, and the cluster labels
  // of Cosmograph move with it. The capture hides both.
  parameters: {
    visual: { masks: ["canvas", ".css-label--labels-container"] },
  },
  play: async ({ canvasElement }) => {
    const search = await within(canvasElement).findByLabelText(
      "Search nodes",
      {},
      { timeout: layoutSettleTimeout },
    )
    const overlay = search.closest("[inert]")
    await expect(overlay).not.toBeNull()
    await expect(getComputedStyle(overlay as Element).opacity).toBe("0.4")
    search.focus()
    await expect(search).not.toHaveFocus()
  },
}

const timelineSelections =
  fn<(selection: KnowledgeGraphSelectionEvent | null) => void>()

/**
 * Graph canvas of the knowledge graph, where a user explores how the files of a
 * Workspace link: the timeline played the history with no brushed range and is
 * paused. Play starts from the first part of the history and moves the window
 * forward, with one selection for each step.
 */
export const TimelinePlaysWithoutRange: Story = {
  args: { onSelectionChange: timelineSelections },
  // The WebGL canvas draws a new frame at each shot, so the capture hides it.
  parameters: {
    visual: { masks: ["canvas"] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const playButton = await canvas.findByRole(
      "button",
      { name: "Play history" },
      { timeout: layoutSettleTimeout },
    )
    await waitFor(() => expect(playButton).toBeEnabled(), {
      timeout: layoutSettleTimeout,
    })
    // The timeline moves the window one step on each tick of a 50 ms
    // interval. A pause after a wait can come one or two steps late, and then
    // the screenshot changes. Thus the play pauses in the third selection
    // callback, which is in the tick: the next tick does not occur.
    const steps = 3
    timelineSelections.mockClear()
    timelineSelections.mockImplementation(() => {
      if (timelineSelections.mock.calls.length !== steps) return
      canvas.getByRole("button", { name: "Pause history" }).click()
    })
    await userEvent.click(playButton)
    await waitFor(() => expect(timelineSelections).toHaveBeenCalledTimes(steps))
    await canvas.findByRole("button", { name: "Play history" })
    await expect(timelineSelections).toHaveBeenCalledTimes(steps)

    const starts = timelineSelections.mock.calls.map(([selection]) => {
      if (selection?.source !== "timeline") {
        throw new Error("Playback must send only timeline selections")
      }
      return selection.range.from
    })
    for (const [i, start] of starts.slice(1).entries()) {
      await expect(start).toBeGreaterThan(starts[i] ?? start)
    }
  },
}

/**
 * Graph canvas of the knowledge graph, where a user explores how the files of a
 * Workspace link: the browser has WebGL 2 turned off, so a clear message shows
 * instead of a blank canvas.
 */
export const NoWebGL: Story = {
  parameters: {
    intent:
      "Catches a graph canvas that fails with no message when the browser has no WebGL 2. It must show that the browser cannot show the graph. Not for graph data or layout.",
  },
  tags: ["required"],
  beforeEach: () => {
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      if (kind === "webgl2") return null
      return Reflect.apply(getContext, this, [kind, ...rest])
    } as typeof getContext
    return () => {
      HTMLCanvasElement.prototype.getContext = getContext
    }
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText(
        "This browser cannot show the graph",
      ),
    ).toBeVisible()
  },
}
