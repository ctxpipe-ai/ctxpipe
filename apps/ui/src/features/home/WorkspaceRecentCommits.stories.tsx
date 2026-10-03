import type { Meta, StoryObj } from "@storybook/react-vite"
import { docsWorkspaceActivityRecent } from "@/features/workspaces/workspace-fixtures"
import { WorkspaceRecentCommits } from "./WorkspaceRecentCommits"

const meta = {
  title: "Components/Home/Recent commits",
  component: WorkspaceRecentCommits,
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof WorkspaceRecentCommits>

export default meta

type Story = StoryObj<typeof meta>

export const Populated: Story = {
  args: {
    commits: docsWorkspaceActivityRecent,
  },
}

export const NoHistory: Story = {
  args: {
    commits: [],
  },
}
