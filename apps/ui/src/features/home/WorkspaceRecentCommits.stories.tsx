import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  expectSkeletonMatchesLoaded,
  SkeletonMatchFrame,
} from "@/components/ui/skeletonMatchStory"
import { docsWorkspaceActivityRecent } from "@/features/workspaces/workspace-fixtures"
import {
  WorkspaceRecentCommits,
  WorkspaceRecentCommitsSkeleton,
} from "./WorkspaceRecentCommits"

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

export const Loading: Story = {
  args: {
    commits: [],
  },
  render: () => <WorkspaceRecentCommitsSkeleton />,
}

/** The skeleton has the same box as five loaded commits (the API limit). */
export const RecentCommitsSkeletonMatches: Story = {
  tags: ["workspace-golden"],
  args: {
    commits: docsWorkspaceActivityRecent,
  },
  render: () => (
    <SkeletonMatchFrame
      className="w-xl"
      skeleton={<WorkspaceRecentCommitsSkeleton />}
      loaded={<WorkspaceRecentCommits commits={docsWorkspaceActivityRecent} />}
    />
  ),
  play: async ({ canvasElement }) => {
    await expectSkeletonMatchesLoaded(canvasElement)
  },
}
