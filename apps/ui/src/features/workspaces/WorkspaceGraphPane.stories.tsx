import type { Decorator, Meta, StoryObj } from "@storybook/react-vite"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceGraphPane } from "./WorkspaceGraphPane"
import { docsWorkspaceGraph } from "./workspace-fixtures"

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
  decorators: [paneFrame("w-full"), ...entryPageInnerDecorators],
  args: {
    orgSlug: "acme",
    workspaceSlug: "docs",
    pending: false,
  },
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof WorkspaceGraphPane>

export default meta

type Story = StoryObj<typeof meta>

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

export const Loading: Story = {
  args: { graph: undefined, pending: true },
}

export const Populated: Story = {
  args: {
    pending: false,
    graph: docsWorkspaceGraph,
  },
}

export const NarrowPane: Story = {
  args: {
    pending: false,
    graph: docsWorkspaceGraph,
  },
  decorators: [paneFrame("w-96")],
}

export const WidePane: Story = {
  args: {
    pending: false,
    graph: docsWorkspaceGraph,
  },
  decorators: [paneFrame("w-full max-w-5xl")],
}
