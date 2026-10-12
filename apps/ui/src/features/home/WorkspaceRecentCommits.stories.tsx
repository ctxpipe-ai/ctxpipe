import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
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

/**
 * A commit link tells that it opens in a new tab. Its external-link icon
 * shows on hover and on keyboard focus, together with the focus ring.
 */
export const OpensInNewTab: Story = {
  args: {
    commits: docsWorkspaceActivityRecent,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const title = canvas.getByRole("link", {
      name: "Document billing ledger rules (opens in a new tab)",
    })
    expect(title).toHaveAttribute("target", "_blank")
    expect(title).toHaveAttribute("rel", "noopener noreferrer")
    expect(
      canvas.getByRole("link", {
        name: "Commit abc123d (opens in a new tab)",
      }),
    ).toHaveAttribute("target", "_blank")
    // A commit without a URL is plain text, not a link.
    expect(
      canvas.queryByRole("link", { name: /Refresh payments API claims/ }),
    ).not.toBeInTheDocument()

    const icon = title.querySelector("svg")
    if (!icon) throw new Error("The title link has no external-link icon")
    expect(getComputedStyle(icon).opacity).toBe("0")

    await userEvent.hover(title)
    await waitFor(() => expect(getComputedStyle(icon).opacity).toBe("1"))
    await userEvent.unhover(title)
    await waitFor(() => expect(getComputedStyle(icon).opacity).toBe("0"))

    await userEvent.tab()
    expect(title).toHaveFocus()
    await waitFor(() => expect(getComputedStyle(icon).opacity).toBe("1"))
    expect(getComputedStyle(title).outlineStyle).toBe("solid")
    expect(getComputedStyle(title).outlineWidth).toBe("2px")
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
