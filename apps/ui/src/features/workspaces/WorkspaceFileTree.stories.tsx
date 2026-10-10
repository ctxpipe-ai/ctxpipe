import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ComponentProps, useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { Button } from "@/components/ui/Button"
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
    const search = await canvas.findByRole("button", { name: "Search files" })
    await userEvent.click(search)
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

function findInShadows(root: ParentNode, selector: string): HTMLElement | null {
  const direct = root.querySelector(selector)
  if (direct instanceof HTMLElement) return direct
  for (const element of root.querySelectorAll("*")) {
    if (!element.shadowRoot) continue
    const nested = findInShadows(element.shadowRoot, selector)
    if (nested) return nested
  }
  return null
}

function PierreKeyboardFocusHarness(
  props: ComponentProps<typeof WorkspaceFileTree>,
) {
  const [selectedPath, setSelectedPath] = useState(props.selectedPath)
  return (
    <WorkspaceFileTree
      {...props}
      selectedPath={selectedPath}
      onSelect={(path) => {
        setSelectedPath(path)
        props.onSelect?.(path)
      }}
    />
  )
}

export const PierreKeyboardFocus: Story = {
  tags: ["workspace-golden"],
  args: {
    paths: ["AGENTS.md", "knowledge/billing.md"],
    selectedPath: "AGENTS.md",
    onSelect: fn(),
  },
  render: (args) => <PierreKeyboardFocusHarness {...args} />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const search = await canvas.findByRole("button", { name: "Search files" })
    await userEvent.click(search)
    await waitFor(() => {
      expect(
        findInShadows(canvasElement, "input") ??
          findInShadows(canvasElement, "[role='searchbox']"),
      ).toBeTruthy()
    })
    const input =
      findInShadows(canvasElement, "input") ??
      findInShadows(canvasElement, "[role='searchbox']")
    if (!input) throw new Error("Pierre search field was not found")
    await userEvent.type(input, "billing")
    await userEvent.keyboard("{Enter}")
    await waitFor(() => {
      expect(args.onSelect).toHaveBeenCalled()
    })
    await userEvent.keyboard("{Escape}")
    await waitFor(() => {
      const selected =
        findInShadows(
          canvasElement,
          "button[data-item-path*='billing'][aria-selected='true']",
        ) ?? findInShadows(canvasElement, "[aria-selected='true']")
      expect(selected).toBeTruthy()
    })
    const selected = (findInShadows(
      canvasElement,
      "button[data-item-path*='billing'][aria-selected='true']",
    ) ?? findInShadows(canvasElement, "[aria-selected='true']")) as HTMLElement
    const selectedPath =
      selected.getAttribute("data-item-path") ??
      selected.getAttribute("aria-label") ??
      selected.textContent ??
      ""
    expect(selectedPath).toMatch(/billing/i)
    const focused = canvasElement.ownerDocument.activeElement
    const pierreFocused = findInShadows(
      canvasElement,
      "button[data-item-focused='true']",
    )
    expect(pierreFocused).toBeTruthy()
    expect(pierreFocused?.getAttribute("data-item-path") ?? "").toMatch(
      /billing/i,
    )
    expect(
      selected === focused ||
        selected.contains(focused) ||
        Boolean(
          selected.shadowRoot &&
            focused &&
            selected.shadowRoot.contains(focused),
        ) ||
        pierreFocused === selected,
    ).toBe(true)
    expect(args.onSelect).toHaveBeenCalled()
  },
}

export const DeletedFile: Story = {
  args: {
    paths: ["AGENTS.md", "knowledge/billing.md"],
    selectedPath: "knowledge/billing.md",
    gitStatus: [
      { path: "knowledge/old-pricing.md", status: "deleted", deletions: 12 },
    ],
  },
}

export const DeletedFolder: Story = {
  args: {
    paths: ["AGENTS.md", "knowledge/billing.md"],
    selectedPath: "knowledge/billing.md",
    gitStatus: [
      { path: "knowledge/archive/2023.md", status: "deleted", deletions: 40 },
      { path: "knowledge/archive/2024.md", status: "deleted", deletions: 31 },
    ],
  },
}

export const MixedAddedModifiedDeleted: Story = {
  decorators: [
    (Story) => (
      <div className="flex h-96 w-80 flex-col bg-card">
        <Story />
      </div>
    ),
  ],
  args: {
    paths: [...docsWorkspaceGitTree.paths, "knowledge/billing/refunds.md"],
    selectedPath: "knowledge/billing/ledger.md",
    gitStatus: [
      {
        path: "knowledge/billing/ledger.md",
        status: "modified",
        additions: 2,
        deletions: 1,
      },
      {
        path: "knowledge/billing/refunds.md",
        status: "added",
        additions: 18,
        deletions: 0,
      },
      {
        path: "knowledge/billing/invoices-legacy.md",
        status: "deleted",
        deletions: 25,
      },
    ],
  },
}

export const DeletedLongNestedName: Story = {
  decorators: [
    (Story) => (
      <div className="flex h-96 w-44 flex-col bg-card">
        <Story />
      </div>
    ),
  ],
  args: {
    paths: ["knowledge/auth/a-very-long-session-handler-module-name.tsx"],
    selectedPath: "knowledge/auth/a-very-long-session-handler-module-name.tsx",
    gitStatus: [
      {
        path: "knowledge/auth/deep/nested/a-very-long-deleted-oauth-callback-handler.tsx",
        status: "deleted",
        deletions: 88,
      },
    ],
  },
}

function DeletedFileHarness(props: ComponentProps<typeof WorkspaceFileTree>) {
  const [gitStatus, setGitStatus] = useState(props.gitStatus)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Button variant="quiet" onPress={() => setGitStatus([])}>
        Merge into base branch
      </Button>
      <WorkspaceFileTree {...props} gitStatus={gitStatus} />
    </div>
  )
}

const deletedRowSelector = "button[data-item-path='old-pricing.md']"

export const DeletedFileStaysUntilMerged: Story = {
  tags: ["workspace-golden"],
  args: {
    paths: ["AGENTS.md", "knowledge/billing.md"],
    selectedPath: "AGENTS.md",
    onSelect: fn(),
    gitStatus: [{ path: "old-pricing.md", status: "deleted", deletions: 12 }],
  },
  render: (args) => <DeletedFileHarness {...args} />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await waitFor(() => {
      expect(findInShadows(canvasElement, deletedRowSelector)).toBeTruthy()
    })
    const row = findInShadows(canvasElement, deletedRowSelector) as HTMLElement
    expect(row.getAttribute("data-item-git-status")).toBe("deleted")
    const name = row.querySelector("[data-item-section='content']")
    if (!name) throw new Error("Deleted row has no name")
    const view = canvasElement.ownerDocument.defaultView
    expect(view?.getComputedStyle(name).textDecorationLine).toBe("line-through")

    const summary = canvas.getByText(
      "Deleted in this conversation: old-pricing.md.",
    )
    const host = canvasElement.querySelector("[aria-describedby]")
    expect(host?.getAttribute("aria-describedby")).toBe(summary.id)

    await userEvent.click(row)
    expect(args.onSelect).not.toHaveBeenCalledWith("old-pricing.md")
    await waitFor(() => {
      expect(row.getAttribute("aria-selected")).toBe("false")
      expect(
        findInShadows(
          canvasElement,
          "button[data-item-path='AGENTS.md']",
        )?.getAttribute("aria-selected"),
      ).toBe("true")
    })

    await userEvent.click(
      canvas.getByRole("button", { name: "Merge into base branch" }),
    )
    await waitFor(() => {
      expect(findInShadows(canvasElement, deletedRowSelector)).toBeNull()
    })
    expect(canvas.queryByText(/Deleted in this conversation/)).toBeNull()
  },
}

export const ChangeMarkers: Story = {
  tags: ["workspace-golden"],
  args: {
    paths: [
      "AGENTS.md",
      "README.md",
      "new-guide.md",
      "knowledge/billing.md",
      "knowledge/refunds.md",
    ],
    selectedPath: "AGENTS.md",
    gitStatus: [
      { path: "new-guide.md", status: "added", additions: 18, deletions: 0 },
      { path: "README.md", status: "modified", additions: 4, deletions: 1 },
      { path: "old-pricing.md", status: "deleted", deletions: 12 },
      { path: "knowledge/refunds.md", status: "added", additions: 6 },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const row = (path: string) =>
      findInShadows(canvasElement, `button[data-item-path='${path}']`)
    await waitFor(() => {
      expect(row("new-guide.md")).toBeTruthy()
    })
    const view = canvasElement.ownerDocument.defaultView
    const marker = (path: string) => {
      const lane = row(path)?.querySelector("[data-item-section='git']")
      if (!lane) throw new Error(`${path} has no change marker lane`)
      return {
        text: lane.textContent ?? "",
        title: lane.querySelector("[title]")?.getAttribute("title") ?? null,
        color: view?.getComputedStyle(lane).color,
      }
    }

    const added = marker("new-guide.md")
    expect(added.text).toBe("A")
    expect(added.title).toBe("Git status: added")
    expect(added.color).toBe("rgb(52, 211, 153)")
    const modified = marker("README.md")
    expect(modified.text).toBe("M")
    expect(modified.color).toBe("oklch(0.828 0.189 84.429)")
    const deleted = marker("old-pricing.md")
    expect(deleted.text).toBe("D")
    expect(deleted.color).not.toBe(modified.color)
    expect(row("AGENTS.md")?.hasAttribute("data-item-git-status")).toBe(false)
    expect(marker("AGENTS.md").text).toBe("")

    const folder = findInShadows(
      canvasElement,
      "[data-item-type='folder'][data-item-contains-git-change='true']",
    )
    expect(folder?.getAttribute("data-item-path")).toMatch(/^knowledge\/?$/)

    const host = canvasElement.querySelector("[aria-describedby]")
    const summary = canvasElement.ownerDocument.getElementById(
      host?.getAttribute("aria-describedby") ?? "",
    )
    expect(summary?.textContent).toBe(
      "Added in this conversation: new-guide.md, knowledge/refunds.md. " +
        "Modified in this conversation: README.md. " +
        "Deleted in this conversation: old-pricing.md.",
    )
    expect(canvas.getByText(/Added in this conversation/)).toBe(summary)
  },
}
