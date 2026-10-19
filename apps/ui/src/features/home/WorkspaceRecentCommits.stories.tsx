import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  expectSkeletonMatchesLoaded,
  SkeletonMatchFrame,
} from "@/components/ui/skeletonMatchStory"
import type { WorkspaceActivityCommit } from "@/features/workspaces/types"
import { docsWorkspaceActivityRecent } from "@/features/workspaces/workspace-fixtures"
import { formatDate } from "@/lib/format"
import {
  formatCommitTime,
  WorkspaceRecentCommits,
  WorkspaceRecentCommitsSkeleton,
} from "./WorkspaceRecentCommits"

/** Ten commits: one page of the Home list. */
const pageOfCommits: WorkspaceActivityCommit[] = [
  ...docsWorkspaceActivityRecent,
  ...docsWorkspaceActivityRecent.map((commit) => ({
    ...commit,
    sha: `9${commit.sha.slice(1)}`,
  })),
]

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
 * The short hash links to the commit in a new tab. Its external-link icon
 * shows on hover and on keyboard focus, together with the focus ring.
 */
export const OpensInNewTab: Story = {
  args: {
    commits: docsWorkspaceActivityRecent,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const hash = canvas.getByRole("link", {
      name: "Commit abc123d (opens in a new tab)",
    })
    expect(hash).toHaveAttribute("target", "_blank")
    expect(hash).toHaveAttribute("rel", "noopener noreferrer")
    expect(hash).toHaveAttribute(
      "href",
      "https://github.com/acme/docs/commit/abc123def456",
    )
    expect(getComputedStyle(hash).fontFamily).toMatch(/mono/i)
    // The message is text, not a second link to the same commit.
    expect(
      canvas.queryByRole("link", { name: /Document billing ledger rules/ }),
    ).not.toBeInTheDocument()
    // A commit without a URL shows its hash as plain text.
    expect(
      canvas.queryByRole("link", { name: /Commit d00dad2/ }),
    ).not.toBeInTheDocument()
    expect(canvas.getByText("d00dad2")).toBeVisible()

    const icon = hash.querySelector("svg")
    if (!icon) throw new Error("The hash link has no external-link icon")
    expect(getComputedStyle(icon).opacity).toBe("0")

    // Each wait names its step, so a failure shows which state never came.
    const iconOpacity = (step: string, opacity: string) =>
      waitFor(() => {
        const seen = getComputedStyle(icon).opacity
        if (seen !== opacity)
          throw new Error(`${step}: icon opacity is ${seen}, not ${opacity}`)
      })
    await userEvent.hover(hash)
    await iconOpacity("on hover", "1")
    await userEvent.unhover(hash)
    await iconOpacity("after hover", "0")

    // The time comes first in the tab order, then the hash.
    await userEvent.tab()
    await userEvent.tab()
    await waitFor(() =>
      expect(
        canvas.getByRole("link", {
          name: "Commit abc123d (opens in a new tab)",
        }),
      ).toHaveFocus(),
    )
    await iconOpacity("on keyboard focus", "1")
    expect(getComputedStyle(hash).outlineStyle).toBe("solid")
    expect(getComputedStyle(hash).outlineWidth).toBe("2px")
  },
}

const longCommit = {
  ...docsWorkspaceActivityRecent[0],
  subject:
    "Rewrite the billing ledger rules so that every refund, credit, and partial capture has one clear owner and one audit trail",
} satisfies WorkspaceActivityCommit

/**
 * One line per commit: avatar, message, time, hash. A long message ends in
 * an ellipsis, and the time and hash stay whole at the right.
 */
export const CompactRowTruncates: Story = {
  tags: ["workspace-golden"],
  args: {
    commits: [longCommit, ...docsWorkspaceActivityRecent.slice(1)],
  },
  decorators: [
    (Story) => (
      <div className="w-md">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const message = canvas.getByText(longCommit.subject)
    expect(getComputedStyle(message).textOverflow).toBe("ellipsis")
    await document.fonts.ready
    expect(message.scrollWidth).toBeGreaterThan(message.clientWidth)
    const row = message.parentElement
    if (!row) throw new Error("The message has no row")
    const hash = within(row).getByRole("link", { name: /Commit abc123d/ })
    const time = row.querySelector("time")
    if (!time) throw new Error("The row has no time")
    // One line: the avatar, message, time, and hash share a center line.
    const middle = (element: Element) => {
      const box = element.getBoundingClientRect()
      return box.top + box.height / 2
    }
    for (const element of [time, hash])
      expect(Math.abs(middle(element) - middle(message))).toBeLessThan(2)
    expect(time.getBoundingClientRect().left).toBeGreaterThan(
      message.getBoundingClientRect().right,
    )
    expect(hash.getBoundingClientRect().right).toBeLessThanOrEqual(
      row.getBoundingClientRect().right + 0.5,
    )
    expect(within(row).getByText("Ada:")).toHaveClass("sr-only")
  },
}

/** The time ago tells the full local date and time in a tooltip. */
export const TimeTooltip: Story = {
  args: {
    commits: docsWorkspaceActivityRecent,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const commit = docsWorkspaceActivityRecent[0]
    const time = canvasElement.querySelector(
      `time[datetime="${commit.committedAt}"]`,
    )
    if (!(time instanceof HTMLElement)) throw new Error("No commit time")
    expect(time).toHaveTextContent(formatDate(commit.committedAt))

    await userEvent.tab()
    expect(time).toHaveFocus()
    const tooltip = await page.findByRole("tooltip")
    expect(tooltip).toHaveTextContent(formatCommitTime(commit.committedAt))
    expect(time).toHaveAttribute("aria-describedby", tooltip.id)
    expect(canvas.getAllByRole("link")[0]).not.toHaveFocus()
  },
}

/**
 * The commit line is decorative. Its segments touch from row to row, and
 * each node sits at the center line of its row, also with a taller row.
 */
export const CommitLineAligns: Story = {
  tags: ["workspace-golden"],
  args: {
    commits: [longCommit, ...docsWorkspaceActivityRecent.slice(1)],
    showWorkspace: true,
  },
  decorators: [
    (Story) => (
      <div className="w-md text-base">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    await document.fonts.ready
    const lines = [
      ...canvasElement.querySelectorAll<HTMLElement>("[data-commit-line]"),
    ]
    expect(lines).toHaveLength(5)
    for (const [index, line] of lines.entries()) {
      expect(line).toHaveAttribute("aria-hidden", "true")
      const row = line.parentElement
      if (!row) throw new Error("The line has no row")
      const rowBox = row.getBoundingClientRect()
      const lineBox = line.getBoundingClientRect()
      expect(lineBox.top).toBeCloseTo(rowBox.top, 0)
      expect(lineBox.bottom).toBeCloseTo(rowBox.bottom, 0)
      const node = line.lastElementChild
      if (!node) throw new Error("The line has no node")
      const nodeBox = node.getBoundingClientRect()
      expect(nodeBox.top + nodeBox.height / 2).toBeCloseTo(
        rowBox.top + rowBox.height / 2,
        0,
      )
      const next = lines[index + 1]
      if (next)
        expect(next.getBoundingClientRect().top).toBeCloseTo(lineBox.bottom, 0)
    }
  },
}

/** A 1x1 PNG, so the avatar story needs no network. */
const pixelPng = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
)

/** The GitHub avatar of each image request (login, auth header). */
const avatarRequests: { login: string; authorization: string | null }[] = []

/**
 * A commit with a GitHub login shows the GitHub avatar of that login. A
 * commit without a login, or with an avatar that does not load, shows the
 * initial of the author.
 */
export const AvatarAndInitialFallback: Story = {
  tags: ["workspace-golden"],
  args: {
    commits: [
      { ...docsWorkspaceActivityRecent[0], authorLogin: "ada-gh" },
      { ...docsWorkspaceActivityRecent[1], authorLogin: null },
      { ...docsWorkspaceActivityRecent[2], authorLogin: "gone-user" },
    ],
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get("https://github.com/:file", ({ params, request }) => {
            const login = String(params.file).replace(/\.png$/, "")
            avatarRequests.push({
              login,
              authorization: request.headers.get("authorization"),
            })
            if (login === "gone-user")
              return new HttpResponse(null, { status: 404 })
            return HttpResponse.arrayBuffer(pixelPng.buffer, {
              headers: { "Content-Type": "image/png" },
            })
          }),
        ],
      },
    },
  },
  beforeEach: () => {
    avatarRequests.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const row = (subject: string) => {
      const element = canvas.getByText(subject).parentElement
      if (!element) throw new Error(`No row for ${subject}`)
      return element
    }
    const ada = row("Document billing ledger rules")
    const avatar = ada.querySelector("img")
    if (!avatar) throw new Error("The row with a login has no avatar")
    expect(avatar).toHaveAttribute(
      "src",
      "https://github.com/ada-gh.png?size=40",
    )
    expect(avatar).toHaveAttribute("referrerpolicy", "no-referrer")
    expect(avatar).toHaveAttribute("alt", "")
    await waitFor(() => expect(avatar.naturalWidth).toBeGreaterThan(0))

    const lin = row("Clarify session cookie policy")
    expect(lin.querySelector("img")).toBeNull()
    expect(lin).toHaveTextContent(/^L/)

    const gone = row("Add on-call severity notes")
    await waitFor(() => expect(gone.querySelector("img")).toBeNull())
    expect(gone).toHaveTextContent(/^S/)

    // The image requests carry no token.
    expect(avatarRequests.map((request) => request.login).sort()).toEqual([
      "ada-gh",
      "gone-user",
    ])
    for (const request of avatarRequests)
      expect(request.authorization).toBeNull()
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
  play: async ({ canvasElement }) => {
    // Three rows with falling opacity: the skeleton does not guess the count.
    const rows = canvasElement.querySelectorAll("li")
    expect(rows).toHaveLength(3)
    expect(
      Array.from(rows, (row) => getComputedStyle(row).opacity),
    ).toEqual(["0.75", "0.5", "0.25"])
  },
}

/** The skeleton has the same box as three loaded commits. */
export const RecentCommitsSkeletonMatches: Story = {
  tags: ["workspace-golden"],
  args: {
    commits: pageOfCommits.slice(0, 3),
  },
  render: () => (
    <SkeletonMatchFrame
      className="w-xl"
      skeleton={<WorkspaceRecentCommitsSkeleton />}
      loaded={<WorkspaceRecentCommits commits={pageOfCommits.slice(0, 3)} />}
    />
  ),
  play: async ({ canvasElement }) => {
    await expectSkeletonMatchesLoaded(canvasElement)
  },
}
