import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceFileTree } from "./WorkspaceFileTree"

const meta = {
  title: "Components/Workspaces/FileTree",
  component: WorkspaceFileTree,
  decorators: [
    (Story) => (
      <div className="w-64 bg-zinc-950 p-3">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: {
    selectedPath: "knowledge/billing.md",
    onSelect: fn(),
    onOpenTab: fn(),
    nodes: [
      {
        name: "knowledge",
        path: "knowledge",
        children: [
          { name: "billing.md", path: "knowledge/billing.md" },
          { name: "auth.md", path: "knowledge/auth.md" },
        ],
      },
    ],
  },
} satisfies Meta<typeof WorkspaceFileTree>

export default meta

type Story = StoryObj<typeof meta>

export const FilesPane: Story = {}

export const EmptyProjection: Story = {
  args: { nodes: [], selectedPath: null },
}
