import type { Decorator } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { waitForGraphReady } from "@/features/knowledge-graph/graphReadyStory"
import { knowledgeGraphIntroStorageKey } from "@/features/knowledge-graph/knowledgeGraphIntroStorage"
import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import { docsWorkspaceGraph } from "./workspace-fixtures"
import { WorkspaceGraphPane } from "./WorkspaceGraphPane"

function paneFrame(widthClass: string): Decorator {
  return (Story) => (
    <div className={`flex h-[32rem] overflow-hidden bg-zinc-950 ${widthClass}`}>
      <Story />
    </div>
  )
}

const meta = preview.meta({
  title: "Components/Workspaces/GraphPane",
  component: WorkspaceGraphPane,
  decorators: [paneFrame("w-full")],
  args: {
    orgSlug: "acme",
    workspaceSlug: "docs",
    pending: false,
    onRetry: () => undefined,
  },
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers)
  },
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
})

/**
 * Knowledge graph pane of a Workspace, where a member explores how the
 * knowledge links: the graph has no nodes yet.
 */
export const EmptyProjection = meta.story({
  args: {
    pending: false,
    graph: {
      ...docsWorkspaceGraph,
      metrics: {
        ...docsWorkspaceGraph.metrics,
        totalNodes: 0,
        totalEdges: 0,
        nodesReturned: 0,
        edgesReturned: 0,
      },
      nodes: [],
      edges: [],
    },
  },
})

/**
 * Knowledge graph pane of a Workspace, where a member explores how the
 * knowledge links: the graph request still runs, so a progress bar and its
 * status show.
 */
export const Loading = meta.story({
  args: { graph: undefined, pending: true },
})

/**
 * Knowledge graph pane of a Workspace, where a member explores how the
 * knowledge links: a full graph with nodes and edges.
 */
export const Populated = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.queryByText(/but no edges yet/)).toBeNull() // play-timing: ok the pane draws this note from props, with no request
  },
  args: {
    pending: false,
    graph: docsWorkspaceGraph,
  },
})

/**
 * Knowledge graph pane of a Workspace in a narrow pane, where a member explores
 * how the knowledge links: the graph data arrived, and ctxpipe prepares the
 * view.
 */
export const NarrowPane = meta.story({
  args: {
    pending: false,
    graph: docsWorkspaceGraph,
  },
  decorators: [paneFrame("w-96")],
})

/**
 * Knowledge graph pane of a Workspace, where a member explores how the
 * knowledge links: a full graph in a wide pane.
 */
export const WidePane = meta.story({
  args: {
    pending: false,
    graph: docsWorkspaceGraph,
  },
  decorators: [paneFrame("w-full max-w-5xl")],
})

/**
 * Knowledge graph pane of a Workspace, where a member explores how the
 * knowledge links: the graph has nodes but no edges, and a note says so.
 */
export const NodesWithoutRelationships = meta.story({
  parameters: {
    intent:
      "Catches a graph with nodes but no edges that shows a blank pane. It says how many nodes it has and that it has no edges yet. Not for graphs with edges.",
  },
  tags: ["required"],
  args: {
    pending: false,
    graph: {
      ...docsWorkspaceGraph,
      metrics: {
        ...docsWorkspaceGraph.metrics,
        totalEdges: 0,
        edgesReturned: 0,
      },
      edges: [],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText(/has 28 nodes but no edges yet/)).toBeVisible(),
    )
  },
})

/**
 * Knowledge graph pane of a Workspace, where a member explores how the
 * knowledge links. The member closed the tips. The browser keeps that choice
 * for the org, so the tips do not open on the next visit. To hide them on the
 * tool rail has the same result.
 */
export const ClosingTipsIsRemembered = meta.story({
  args: {
    pending: false,
    graph: docsWorkspaceGraph,
  },
  parameters: {
    visual: {
      skip: "The end state is the graph without the tips panel, as in TipsClosedEarlier.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The graph controls and the tips show when the layout has settled.
    await waitForGraphReady(canvasElement)
    const tips = await canvas.findByRole("dialog", {
      name: "Knowledge graph tips",
    })
    await userEvent.click(
      within(tips).getByRole("button", { name: "Close tips" }),
    )
    await waitFor(() =>
      expect(
        canvas.queryByRole("dialog", { name: "Knowledge graph tips" }),
      ).toBeNull(),
    )
    await expect(
      window.localStorage.getItem(knowledgeGraphIntroStorageKey("acme")),
    ).toBe("1")
    // Hide tips on the tool rail is also a dismissal.
    window.localStorage.removeItem(knowledgeGraphIntroStorageKey("acme"))
    await userEvent.click(canvas.getByRole("button", { name: "Show tips" }))
    await canvas.findByRole("dialog", { name: "Knowledge graph tips" })
    await userEvent.click(canvas.getByRole("button", { name: "Hide tips" }))
    await expect(
      window.localStorage.getItem(knowledgeGraphIntroStorageKey("acme")),
    ).toBe("1")
  },
})

/**
 * Knowledge graph pane of a Workspace, where a member explores how the
 * knowledge links. The member closed the tips on an earlier visit, so the graph
 * opens without them.
 */
export const TipsClosedEarlier = meta.story({
  args: {
    pending: false,
    graph: docsWorkspaceGraph,
  },
  parameters: {
    visual: {
      skip: "Without the tips panel, the graph labels still move when the play ends. The play checks the behavior.",
    },
  },
  beforeEach: () => {
    window.localStorage.setItem(knowledgeGraphIntroStorageKey("acme"), "1")
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitForGraphReady(canvasElement)
    canvas.getByRole("button", { name: "Show tips" })
    await expect(
      canvas.queryByRole("dialog", { name: "Knowledge graph tips" }),
    ).toBeNull()
  },
})
