import type { Meta, StoryObj } from "@storybook/react-vite"
import { userEvent, within } from "storybook/test"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceGraphPane } from "./WorkspaceGraphPane"
import { docsWorkspaceGraph } from "./workspace-fixtures"

const graphWithOrphan = {
  ...docsWorkspaceGraph,
  metrics: {
    ...docsWorkspaceGraph.metrics,
    totalNodes: 3,
    totalEdges: 1,
    nodesReturned: 3,
    edgesReturned: 1,
  },
  nodes: [
    ...docsWorkspaceGraph.nodes,
    {
      id: "knowledge/orphan.md",
      kind: "file",
      name: "orphan.md",
      summary: "No claims yet",
    },
  ],
}

const meta = {
  title: "Components/Workspaces/GraphPane",
  component: WorkspaceGraphPane,
  decorators: [
    (Story) => (
      <div className="flex h-[24rem] bg-zinc-950">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
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
  args: { graph: undefined, pending: false },
}

export const Loading: Story = {
  args: { graph: undefined, pending: true },
}

export const WithUnits: Story = {
  args: {
    pending: false,
    graph: docsWorkspaceGraph,
  },
}

export const UnitSelected: Story = {
  args: {
    pending: false,
    graph: docsWorkspaceGraph,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "billing.md" }))
  },
}

export const UnitNoClaims: Story = {
  args: {
    pending: false,
    graph: graphWithOrphan,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "orphan.md" }))
  },
}
