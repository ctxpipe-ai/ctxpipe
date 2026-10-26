import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { Suspense } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { conversationGitDiffHandler } from "@/mocks/workspace-handlers"

import type { ConversationGitDiffItem } from "./types"
import { WorkspaceConversationDiffPane } from "./WorkspaceConversationDiff"

const lines = (count: number, label: string) =>
  Array.from({ length: count }, (_, index) => `${label} ${index + 1}`).join(
    "\n",
  )

const manyFiles: ConversationGitDiffItem[] = Array.from(
  { length: 24 },
  (_, index) => {
    const path = `knowledge/decisions/ADR-${String(index + 1).padStart(3, "0")}-decision.md`
    if (index % 6 === 0)
      return {
        path,
        status: "added",
        additions: 5,
        deletions: 0,
        oldBody: null,
        body: lines(5, "New"),
      }
    if (index % 6 === 1)
      return {
        path,
        status: "deleted",
        additions: 0,
        deletions: 3,
        oldBody: lines(3, "Old"),
        body: null,
      }
    return {
      path,
      status: "modified",
      additions: 1,
      deletions: 2,
      oldBody: `${lines(20, "Line")}\n`,
      body: `${lines(18, "Line")}\nChanged line\n`,
    }
  },
)

const longPath =
  "knowledge/memory/decisions/archive/2026/ADR-046-workspace-revision-projection-identity-and-a-very-long-slug.md"

const meta = {
  title: "Components/Workspaces/ConversationDiffPane",
  component: WorkspaceConversationDiffPane,
  decorators: [
    (Story) => (
      <div className="flex h-[40rem] w-[36rem] flex-col bg-card">
        <Suspense fallback={<p>Loading</p>}>
          <Story />
        </Suspense>
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
  args: { orgSlug: "acme", conversationId: "conv_diff" },
} satisfies Meta<typeof WorkspaceConversationDiffPane>

export default meta

type Story = StoryObj<typeof meta>

export const DiffPaneEmpty: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_diff_empty" },
  parameters: {
    intent:
      "Catches a diff pane with no changes that shows an empty toolbar or no message. It says there are no changes against main. Not for diffs with files.",
    msw: { handlers: { page: [conversationGitDiffHandler([])] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("No changes on this branch")).toBeVisible(),
    )
    await expect(
      canvas.getByText("This conversation has no changes against main."),
    ).toBeVisible()
    await expect(canvas.queryByRole("toolbar")).not.toBeInTheDocument()
  },
}

let manyFilesRequests = 0

export const DiffPaneManyFiles: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_diff_many" },
  parameters: {
    intent:
      "Catches a diff pane that drops files or sends extra requests. It lists every changed file with its status from one request. Not for one expanded file.",
    msw: {
      handlers: {
        page: [
          http.get(/\/conversations\/conv_diff_many\/files\/diff$/, () => {
            manyFilesRequests += 1
            return HttpResponse.json({ base: "main", items: manyFiles })
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    manyFilesRequests = 0
    const canvas = within(canvasElement)
    const rows = await canvas.findAllByRole("button", {
      name: /^knowledge\/decisions\/ADR-/,
    })
    await expect(rows).toHaveLength(24)
    await expect(
      canvas.getByRole("button", { name: /ADR-001-decision\.md, Added/ }),
    ).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: /ADR-002-decision\.md, Deleted/ }),
    ).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: /ADR-003-decision\.md, Modified/ }),
    ).toBeVisible()
    // 4 added files of 5 lines, 4 deleted of 3, 16 changed with +1 −2.
    await expect(
      canvas.getByText("Total: 36 added, 44 removed"),
    ).toBeInTheDocument()
    await expect(canvas.getByText("main")).toBeVisible()

    await userEvent.click(canvas.getByRole("button", { name: "Expand all" }))
    await waitFor(() =>
      expect(
        rows.every((row) => row.getAttribute("aria-expanded") === "true"),
      ).toBe(true),
    )
    await userEvent.click(canvas.getByRole("button", { name: "Collapse all" }))
    await waitFor(() =>
      expect(
        rows.every((row) => row.getAttribute("aria-expanded") === "false"),
      ).toBe(true),
    )

    const before = manyFilesRequests
    await userEvent.click(canvas.getByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(manyFilesRequests).toBe(before + 1))
  },
}

export const DiffPaneExpandedFile: Story = {
  tags: ["workspace-golden"],
  args: {
    conversationId: "conv_diff_expanded",
    focusPath: "knowledge/decisions/ADR-021-decision.md",
  },
  parameters: {
    intent:
      "Catches a diff pane that does not open on the chosen file. The file row expands, stays highlighted, and scrolls into view. Not for the file list.",
    msw: { handlers: { page: [conversationGitDiffHandler(manyFiles)] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const focused = await canvas.findByRole("button", {
      name: /ADR-021-decision\.md, Modified/,
    })
    await expect(focused).toHaveAttribute("aria-expanded", "true")
    // The focused row is highlighted, so the user sees which file the Diff opened on.
    await expect(focused.parentElement).toHaveClass("bg-zinc-800")
    const other = canvas.getByRole("button", {
      name: /ADR-001-decision\.md, /,
    })
    await expect(other.parentElement).not.toHaveClass("bg-zinc-800")
    await document.fonts.ready
    // The focused row scrolls into view inside the list.
    await waitFor(() => {
      const list = focused.closest(".overflow-auto") as HTMLElement
      const top = focused.getBoundingClientRect().top
      const listRect = list.getBoundingClientRect()
      expect(top).toBeGreaterThanOrEqual(listRect.top - 1)
      expect(top).toBeLessThan(listRect.bottom)
    })
    const panelId = focused.getAttribute("aria-controls")
    const panel = panelId
      ? canvasElement.ownerDocument.getElementById(panelId)
      : null
    await waitFor(() =>
      expect(panel?.querySelector("diffs-container")).not.toBeNull(),
    )

    await userEvent.click(canvas.getByRole("button", { name: "Split view" }))
    await expect(
      canvas.getByRole("button", { name: "Split view" }),
    ).toHaveAttribute("aria-pressed", "true")

    await userEvent.click(focused)
    await waitFor(() =>
      expect(focused).toHaveAttribute("aria-expanded", "false"),
    )
  },
}

export const DiffPaneLongPaths: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_diff_long" },
  parameters: {
    intent:
      "Catches a long file path that breaks the diff pane layout. The path must truncate and not push other rows out. Not for diff content.",
    msw: {
      handlers: {
        page: [
          conversationGitDiffHandler([
            {
              path: longPath,
              status: "modified",
              additions: 1,
              deletions: 0,
              oldBody: "a\n",
              body: "a\nb\n",
            },
            {
              path: "README.md",
              status: "modified",
              additions: 1,
              deletions: 1,
              oldBody: "x\n",
              body: "y\n",
            },
          ]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const row = await canvas.findByRole("button", {
      name: `${longPath}, Modified`,
    })
    const label = row.querySelector(`[title="${longPath}"]`) as HTMLElement
    await expect(label).toHaveAttribute("dir", "rtl")
    await document.fonts.ready
    // The path is cut, and the start is cut (right to left), so the file
    // name stays in view.
    await expect(label.scrollWidth).toBeGreaterThan(label.clientWidth)

    const writeText = fn(async () => {})
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    await userEvent.click(
      canvas.getByRole("button", { name: `Copy path ${longPath}` }),
    )
    await expect(writeText).toHaveBeenCalledWith(longPath)
    await expect(
      canvas.getByRole("button", { name: "Path copied" }),
    ).toBeVisible()
  },
}

export const DiffPaneRenamedAndOmitted: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_diff_omitted" },
  parameters: {
    intent:
      "Catches a diff row for a renamed, binary, or huge file that shows a broken diff. It shows the rename and an omitted note. Not for normal text diffs.",
    msw: {
      handlers: {
        page: [
          conversationGitDiffHandler([
            {
              path: "docs/moved.md",
              oldPath: "docs/old.md",
              status: "renamed",
              additions: 0,
              deletions: 0,
              oldBody: "same\n",
              body: "same\n",
            },
            {
              path: "assets/logo.png",
              status: "modified",
              additions: 0,
              deletions: 0,
              omitted: "binary",
              oldBody: null,
              body: null,
            },
            {
              path: "data/dump.sql",
              status: "added",
              additions: 40_000,
              deletions: 0,
              omitted: "too_large",
              oldBody: null,
              body: null,
            },
          ]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("button", {
          name: "docs/moved.md, Renamed from docs/old.md",
        }),
      ).toBeVisible(),
    )
    // A binary file is modified, not deleted, and shows no diff.
    const binary = canvas.getByRole("button", {
      name: "assets/logo.png, Modified",
    })
    await userEvent.click(binary)
    await waitFor(() => expect(canvas.getByText("Binary file")).toBeVisible())
    await userEvent.click(
      canvas.getByRole("button", { name: "data/dump.sql, Added" }),
    )
    await waitFor(() =>
      expect(canvas.getByText("File too large to show")).toBeVisible(),
    )
    await expect(
      canvas.getByText("Total: 40000 added, 0 removed"),
    ).toBeInTheDocument()
  },
}

export const DiffPaneTurnGone: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_diff_gone", turn: "run_gone" },
  parameters: {
    intent:
      "Catches a diff of a turn whose snapshot is gone that shows an error screen or toolbar. It shows that the diff is no longer available. Not for current turns.",
    msw: {
      handlers: {
        page: [
          http.get(/\/conversations\/conv_diff_gone\/files\/diff$/, () =>
            HttpResponse.json({ error: "turn_snapshot_gone" }, { status: 410 }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByText("This turn's diff is no longer available."),
      ).toBeVisible(),
    )
    await expect(canvas.queryByRole("toolbar")).not.toBeInTheDocument()
  },
}
