import type { Decorator, Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { knowledgeGraphIntroStorageKey } from "@/features/knowledge-graph/knowledgeGraphIntroStorage"
import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { docsWorkspaceGraph } from "./workspace-fixtures"
import { WorkspaceGraphPane } from "./WorkspaceGraphPane"

function paneFrame(widthClass: string): Decorator {
  return (Story) => (
    <div className={`flex h-[32rem] overflow-hidden bg-zinc-950 ${widthClass}`}>
      <Story />
    </div>
  )
}

const meta = {
  title: "Components/Workspaces/GraphPane",
  component: WorkspaceGraphPane,
  decorators: [paneFrame("w-full")],
  args: {
    orgSlug: "acme",
    workspaceSlug: "docs",
    pending: false,
    onRetry: () => undefined,
  },
  parameters: {
    msw: { handlers: { session: signedInHandlers } },
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof WorkspaceGraphPane>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Knowledge graph pane of a Workspace, where a member explores how the
 * knowledge links: the graph has no nodes yet.
 */
export const EmptyProjection: Story = {
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
}

/**
 * Knowledge graph pane of a Workspace, where a member explores how the
 * knowledge links: the graph request still runs, so a progress bar and its
 * status show.
 */
export const Loading: Story = {
  args: { graph: undefined, pending: true },
}

/**
 * Knowledge graph pane of a Workspace, where a member explores how the
 * knowledge links: a full graph with nodes and edges.
 */
export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.queryByText(/but no edges yet/)).toBeNull() // play-timing: ok the pane draws this note from props, with no request
  },
  args: {
    pending: false,
    graph: docsWorkspaceGraph,
  },
}

/**
 * Knowledge graph pane of a Workspace in a narrow pane, where a member explores
 * how the knowledge links: the graph data arrived, and ctxpipe prepares the
 * view.
 */
export const NarrowPane: Story = {
  args: {
    pending: false,
    graph: docsWorkspaceGraph,
  },
  decorators: [paneFrame("w-96")],
}

/**
 * Knowledge graph pane of a Workspace, where a member explores how the
 * knowledge links: a full graph in a wide pane.
 */
export const WidePane: Story = {
  args: {
    pending: false,
    graph: docsWorkspaceGraph,
  },
  decorators: [paneFrame("w-full max-w-5xl")],
}

/**
 * Knowledge graph pane of a Workspace, where a member explores how the
 * knowledge links: the graph has nodes but no edges, and a note says so.
 */
export const NodesWithoutRelationships: Story = {
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
}

/**
 * Close the tips, or hide them on the tool rail: the browser keeps the
 * choice for the org, so the tips do not open again on the next visit.
 */
export const ClosingTipsIsRemembered: Story = {
  args: {
    pending: false,
    graph: docsWorkspaceGraph,
  },
  parameters: {
    review: {
      purpose:
        "Knowledge graph pane of a Workspace, where a member explores how the knowledge links: the member closed the tips, and the browser keeps that choice.",
    },
    visual: {
      skip: "The end state is the graph without the tips panel, as in TipsClosedEarlier.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The graph controls and the tips show when the layout has settled.
    const tips = await canvas.findByRole(
      "dialog",
      { name: "Knowledge graph tips" },
      { timeout: 15_000 },
    )
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
}

/** The user closed the tips on an earlier visit: the graph opens without them. */
export const TipsClosedEarlier: Story = {
  args: {
    pending: false,
    graph: docsWorkspaceGraph,
  },
  parameters: {
    review: {
      purpose:
        "Knowledge graph pane of a Workspace, where a member explores how the knowledge links: the tips were closed on an earlier visit, so they do not open.",
    },
    visual: {
      skip: "Without the tips panel, the graph labels still move when the play ends. The play checks the behavior.",
    },
  },
  beforeEach: () => {
    window.localStorage.setItem(knowledgeGraphIntroStorageKey("acme"), "1")
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The graph controls show when the layout has settled.
    await canvas.findByRole(
      "button",
      { name: "Show tips" },
      { timeout: 15_000 },
    )
    await expect(
      canvas.queryByRole("dialog", { name: "Knowledge graph tips" }),
    ).toBeNull()
  },
}
