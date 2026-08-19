import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn, userEvent, within } from "storybook/test"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceFileTree } from "./WorkspaceFileTree"
import { docsWorkspaceGitTree } from "./workspace-fixtures"

const nestedPaths = [
  "AGENTS.md",
  "apps/package.json",
  "apps/Button.tsx",
  "knowledge/billing.md",
  "knowledge/auth.md",
  "knowledge/auth/session.ts",
  "knowledge/auth/oauth.ts",
]

function largeTree(): string[] {
  const paths: string[] = ["AGENTS.md"]
  for (let index = 0; index < 40; index += 1) {
    for (let file = 0; file < 50; file += 1) {
      paths.push(`pkg-${index}/file-${file}.ts`)
    }
  }
  return paths
}

const meta = {
  title: "Components/Workspaces/FileTree",
  component: WorkspaceFileTree,
  decorators: [
    (Story) => (
      <div className="flex h-96 w-64 flex-col bg-card">
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
    onPin: fn(),
    onHideTree: fn(),
    paths: nestedPaths,
    writable: true,
  },
} satisfies Meta<typeof WorkspaceFileTree>

export default meta

type Story = StoryObj<typeof meta>

export const Nested: Story = {}

export const SearchOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Search files" }))
  },
}

export const LongNames: Story = {
  decorators: [
    (Story) => (
      <div className="flex h-96 w-44 flex-col bg-card">
        <Story />
      </div>
    ),
  ],
  args: {
    selectedPath: "knowledge/auth/a-very-long-session-handler-module-name.tsx",
    paths: [
      "knowledge/a-very-long-knowledge-article-filename-that-should-ellipsis.md",
      "knowledge/auth/a-very-long-session-handler-module-name.tsx",
    ],
  },
}

export const EmptyProjection: Story = {
  args: { paths: [], selectedPath: null },
}

export const SelectedFile: Story = {
  args: {
    selectedPath: "knowledge/auth/session.ts",
  },
}

export const GitShaped: Story = {
  args: {
    paths: docsWorkspaceGitTree.paths,
    selectedPath: "AGENTS.md",
  },
}

export const GitStatus: Story = {
  decorators: [
    (Story) => (
      <div className="flex h-96 w-80 flex-col bg-card">
        <Story />
      </div>
    ),
  ],
  args: {
    paths: docsWorkspaceGitTree.paths,
    selectedPath: "knowledge/billing/ledger.md",
    gitStatus: [
      {
        path: "knowledge/billing/ledger.md",
        status: "modified",
        additions: 2,
        deletions: 0,
      },
      { path: "AGENTS.md", status: "added", additions: 3, deletions: 0 },
      {
        path: "README.md",
        status: "modified",
        additions: 4,
        deletions: 1,
      },
    ],
  },
}

export const ReadOnly: Story = {
  args: {
    paths: docsWorkspaceGitTree.paths,
    selectedPath: "AGENTS.md",
    writable: false,
  },
}

export const LargeTree: Story = {
  args: {
    paths: largeTree(),
    selectedPath: "pkg-0/file-0.ts",
  },
}
