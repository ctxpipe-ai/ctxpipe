import type { Meta, StoryObj } from "@storybook/react-vite"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceGraphPane } from "./WorkspaceGraphPane"

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
    graph: {
      metrics: {
        totalNodes: 2,
        totalEdges: 1,
        lastUpdatedAt: "2026-08-16T10:00:00.000Z",
        nodesReturned: 2,
        edgesReturned: 1,
        truncated: false,
      },
      nodes: [
        {
          id: "knowledge/billing.md",
          kind: "file",
          name: "billing.md",
          summary: "Invoicing rules",
        },
        {
          id: "knowledge/auth.md",
          kind: "file",
          name: "auth.md",
          summary: "Org auth",
        },
      ],
      edges: [
        {
          sourceId: "knowledge/billing.md",
          targetId: "knowledge/auth.md",
          predicate: "depends_on",
          lastObservedAt: "2026-08-16T10:00:00.000Z",
          confidence: 0.8,
        },
      ],
    },
  },
}
