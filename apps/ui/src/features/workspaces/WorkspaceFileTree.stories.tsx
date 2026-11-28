import { type ComponentProps, useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { Button } from "@/components/ui/Button"
import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import { docsWorkspaceGitTree } from "./workspace-fixtures"
import { WorkspaceFileTree } from "./WorkspaceFileTree"

const nestedPaths = [
  "AGENTS.md",
  "apps/package.json",
  "apps/Button.tsx",
  "knowledge/billing.md",
  "knowledge/auth.md",
  "knowledge/auth/session.ts",
  "knowledge/auth/oauth.ts",
]

/** The knowledge of a large org: one folder for each area, with its usual pages. */
function largeTree(): string[] {
  const areas = [
    "accounts",
    "analytics",
    "api-gateway",
    "audit",
    "auth",
    "billing",
    "checkout",
    "ci",
    "data-platform",
    "deploy",
    "design-system",
    "email",
    "experiments",
    "feature-flags",
    "growth",
    "identity",
    "infrastructure",
    "invoices",
    "ledger",
    "logging",
    "mobile",
    "notifications",
    "observability",
    "onboarding",
    "payments",
    "payroll",
    "permissions",
    "pricing",
    "refunds",
    "search",
    "security",
    "sessions",
    "storage",
    "support",
    "tax",
    "uploads",
    "warehouse",
    "web",
    "webhooks",
    "workflows",
  ]
  const pages = [
    "overview.md",
    "architecture.md",
    "decisions.md",
    "runbook.md",
    "on-call.md",
    "api.md",
    "glossary.md",
    "metrics.md",
    "migrations.md",
    "testing.md",
    "security.md",
    "faq.md",
  ]
  return [
    "AGENTS.md",
    ...areas.flatMap((area) => pages.map((page) => `${area}/${page}`)),
  ]
}

const meta = preview.meta({
  title: "Components/Workspaces/FileTree",
  component: WorkspaceFileTree,
  decorators: [
    (Story) => (
      <div className="flex h-96 w-64 flex-col bg-card">
        <Story />
      </div>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers)
  },
  parameters: {
    app: "root",
    review: { kind: "component" },
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
})

/**
 * File tree of a Workspace, where a member browses and opens files: nested
 * folders with one file selected.
 */
export const Nested = meta.story()

/**
 * File tree of a Workspace, where a member browses and opens files: the file
 * search field is open.
 */
export const SearchOpen = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const search = await canvas.findByRole("button", { name: "Search files" })
    await userEvent.click(search)
  },
})

/**
 * File tree of a Workspace, where a member browses and opens files: long file
 * names in a narrow tree are cut with an ellipsis.
 */
export const LongNames = meta.story({
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
})

/**
 * File tree of a Workspace, where a member browses and opens files: the
 * Workspace has no files yet.
 */
export const EmptyProjection = meta.story({
  args: { paths: [], selectedPath: null },
})

/**
 * File tree of a Workspace, where a member browses and opens files: the tree of
 * a real git repository with AGENTS.md selected.
 */
export const GitShaped = meta.story({
  args: {
    paths: docsWorkspaceGitTree.paths,
    selectedPath: "AGENTS.md",
  },
})

/**
 * File tree of a Workspace, where a member browses and opens files: added and
 * modified files show change markers and line counts.
 */
export const GitStatus = meta.story({
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
})

/**
 * File tree of a Workspace, where a member browses and opens files: a large org
 * keeps one folder for each of its 40 areas, so the tree scrolls and only the
 * top folders fit.
 */
export const LargeTree = meta.story({
  args: {
    paths: largeTree(),
    selectedPath: "billing/overview.md",
  },
})

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

/** DOM focus is on the selected row of the tree, and the row shows its focus ring. */
function expectFocusOnSelectedRow(root: ParentNode, path: RegExp) {
  const host = findInShadows(root, "[role='tree']")?.getRootNode()
  const focused = host instanceof ShadowRoot ? host.activeElement : null
  expect(focused?.getAttribute("aria-selected")).toBe("true")
  expect(focused?.getAttribute("data-item-path") ?? "").toMatch(path)
  expect(focused?.getAttribute("data-item-focused")).toBe("true")
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

/**
 * File tree of a Workspace, where a member browses and opens files: the member
 * found a file with the keyboard search, and Escape put focus back on that row.
 */
export const PierreKeyboardFocus = meta.story({
  parameters: {
    intent:
      "Catches a file tree search that loses keyboard focus. Escape or the header button closes the search and returns focus to the selected row, also when the query hid that row. Typing then Enter selects a file. Not for the file list content.",
  },
  tags: ["required"],
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

    // Escape without Enter cancels the query, which hid the selected row.
    await userEvent.type(input, "billing")
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expectFocusOnSelectedRow(canvasElement, /AGENTS/))

    await userEvent.click(search)
    await waitFor(() => {
      const tree = findInShadows(canvasElement, "[role='tree']")?.getRootNode()
      expect(tree instanceof ShadowRoot && tree.activeElement).toBe(input)
    })
    // The closed search field keeps its text: delete it first.
    await userEvent.type(input, "{Backspace>20/}billing")
    await userEvent.keyboard("{Enter}")
    await waitFor(() => {
      expect(args.onSelect).toHaveBeenCalled()
    })
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expectFocusOnSelectedRow(canvasElement, /billing/i))

    // The header button closes the search the same way.
    await userEvent.click(search)
    await waitFor(() => {
      const tree = findInShadows(canvasElement, "[role='tree']")?.getRootNode()
      expect(tree instanceof ShadowRoot && tree.activeElement).toBe(
        findInShadows(canvasElement, "input"),
      )
    })
    const close = await canvas.findByRole("button", { name: "Close search" })
    await userEvent.click(close)
    await userEvent.unhover(close)
    await waitFor(() => expectFocusOnSelectedRow(canvasElement, /billing/i))
    expect(args.onSelect).toHaveBeenCalled()
  },
})

/**
 * File tree of a Workspace, where a member browses and opens files: the member
 * opened a folder, and a file deleted in this conversation shows as a
 * struck-through row.
 */
export const DeletedFile = meta.story({
  args: {
    paths: ["AGENTS.md", "knowledge/billing.md"],
    selectedPath: "knowledge/billing.md",
    gitStatus: [
      { path: "knowledge/old-pricing.md", status: "deleted", deletions: 12 },
    ],
  },
  play: async ({ canvasElement }) => {
    const folder = await waitFor(() => {
      const row = findInShadows(
        canvasElement,
        "[data-item-type='folder'][data-item-path^='knowledge']",
      )
      expect(row).toBeTruthy()
      return row as HTMLElement
    })
    await userEvent.click(folder)
    await waitFor(() =>
      expect(
        findInShadows(
          canvasElement,
          "[data-item-path='knowledge/old-pricing.md']",
        ),
      ).toBeTruthy(),
    )
  },
})

/**
 * File tree of a Workspace, where a member browses and opens files: one added,
 * one modified, and one deleted file in one folder.
 */
export const MixedAddedModifiedDeleted = meta.story({
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
})

/**
 * File tree of a Workspace, where a member browses and opens files: a deleted
 * file with a long name deep in folders, in a narrow tree.
 */
export const DeletedLongNestedName = meta.story({
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
})

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

/**
 * File tree of a Workspace, where a member browses and opens files: the change
 * was merged into the base branch, so the deleted file row is gone.
 */
export const DeletedFileStaysUntilMerged = meta.story({
  parameters: {
    visual: {
      skip: "Behavior test: it ends on a test harness with a Merge into base branch button, which the product does not render.",
    },
    intent:
      "Catches a deleted file that vanishes from the tree or can be selected. It stays as a struck-through row with a text summary and is not selectable. Not for other markers.",
  },
  tags: ["required"],
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
})

/**
 * File tree of a Workspace, where a member browses and opens files: each added,
 * modified, and deleted file has its marker, and folders mark a change inside.
 */
export const ChangeMarkers = meta.story({
  parameters: {
    intent:
      "Catches file tree rows that miss their change markers. Added, modified, and deleted files show the right marker and counts. Not for folder expansion.",
  },
  tags: ["required"],
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
})

function NewPathsHarness(props: ComponentProps<typeof WorkspaceFileTree>) {
  const [paths, setPaths] = useState(props.paths)
  return (
    <>
      <Button
        variant="quiet"
        onPress={() => setPaths([...props.paths, "sandbox-note.md"])}
      >
        Load new paths
      </Button>
      <WorkspaceFileTree {...props} paths={paths} />
    </>
  )
}

/**
 * File tree of a Workspace, where a member browses and opens files. A new path
 * list loaded (for example, the sandbox tree), and the folder that the member
 * opened stays open.
 */
export const NewPathsKeepExpandedFolders = meta.story({
  parameters: {
    visual: {
      skip: "Behavior test: it ends on a test harness with a Load new paths button, which the product does not render.",
    },
    intent:
      "Catches a path reload that collapses folders the user opened. New paths appear and open folders stay open. Not for the first load.",
  },
  tags: ["required"],
  args: { selectedPath: "AGENTS.md" },
  render: (args) => <NewPathsHarness {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const row = (path: string) =>
      findInShadows(canvasElement, `button[data-item-path='${path}']`)
    const folder = () => row("apps/") ?? row("apps")
    await waitFor(() => {
      expect(folder()).toBeTruthy()
    })
    expect(row("apps/Button.tsx")).toBeNull()
    await userEvent.click(folder() as HTMLElement)
    await waitFor(() => {
      expect(row("apps/Button.tsx")).toBeTruthy()
    })
    await userEvent.click(
      canvas.getByRole("button", { name: "Load new paths" }),
    )
    await waitFor(() => {
      expect(row("sandbox-note.md")).toBeTruthy()
    })
    expect(row("apps/Button.tsx")).toBeTruthy()
    expect(folder()).toHaveAttribute("aria-expanded", "true")
    expect(row("knowledge/auth.md")).toBeNull()
  },
})
