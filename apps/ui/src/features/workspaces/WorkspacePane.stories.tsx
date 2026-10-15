import type { Meta, StoryObj } from "@storybook/react-vite"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { HttpResponse, http } from "msw"
import { type ComponentProps, useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { Button } from "@/components/ui/Button"
import {
  conversationFilePutHandler,
  conversationGitBlobHandler,
  conversationGitDiffHandler,
  conversationGitStatusHandler,
  conversationGitTreeEventuallyHandler,
  conversationGitTreeHandler,
  conversationGitTreeMissingHandler,
  conversationPrepareHandler,
  workspaceFileJobHandler,
  workspaceGitBlobHandler,
  workspaceGitBlobLoadingHandler,
  workspaceGitStatusHandler,
  workspaceGitTreeHandler,
  workspaceGitTreeLoadingHandler,
  workspaceGraphHandler,
  workspaceGraphLoadingHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import {
  clearAllConversationGitTreeSnapshots,
  writeConversationGitTreeSnapshot,
} from "./conversation-git-tree-snapshot"
import {
  closeFileTab,
  type FileTabSession,
  pinFile,
  previewFile,
  seedFileTabSession,
  tabsIncludingPanePath,
} from "./fileTabs"
import { type ParsedPane, parsePane, serializePane } from "./pane"
import { workspaceKeys } from "./queries"
import { useConversationPublish } from "./useConversationPublish"
import { WorkspacePane, WorkspacePaneTriggers } from "./WorkspacePane"
import {
  docsWorkspace,
  docsWorkspaceDetail,
  docsWorkspaceGitBlobs,
  docsWorkspaceGitTree,
  docsWorkspaceGraph,
  readOnlyWorkspaceDetail,
  skippedFilesWorkspaceDetail,
} from "./workspace-fixtures"
import { workspaceChatColumnClassName } from "./workspaceChrome"

const paneCallbacks = {
  onPane: fn(),
  onClose: fn(),
  onToggleMaximize: fn(),
  onRestoreConversation: fn(),
  onResize: fn(),
  onPreviewFile: fn(),
  onPinFile: fn(),
  onCloseFileTab: fn(),
  onCloseActiveFile: fn(),
  onToggleTree: fn(),
}

const gitFilesHandlers = [
  workspaceGitTreeHandler(docsWorkspaceGitTree),
  workspaceGitBlobHandler(docsWorkspaceGitBlobs),
  workspaceGitStatusHandler(),
  workspaceFileJobHandler(),
]

function workspaceFilesHost(canvas: ReturnType<typeof within>) {
  return canvas.getByLabelText("Workspace files")
}

function workspaceFilesText(canvas: ReturnType<typeof within>) {
  const host = workspaceFilesHost(canvas)
  return `${host.textContent ?? ""}${host.shadowRoot?.textContent ?? ""}`
}

/**
 * The tree cuts a long name in the middle, so its text is not the whole name.
 * Each row is a button whose aria-label is the whole name.
 */
function workspaceFileNames(canvas: ReturnType<typeof within>) {
  const rows =
    workspaceFilesHost(canvas).shadowRoot?.querySelectorAll(
      "button[aria-label]",
    ) ?? []
  return [...rows].map((row) => row.getAttribute("aria-label"))
}

async function expectWorkspaceFileNamed(
  canvas: ReturnType<typeof within>,
  name: string,
  timeout?: number,
) {
  await canvas.findByLabelText("Workspace files")
  await waitFor(
    () => {
      expect(workspaceFileNames(canvas)).toContain(name)
    },
    timeout ? { timeout } : undefined,
  )
}

async function expectWorkspaceFiles(
  canvas: ReturnType<typeof within>,
  pattern: RegExp,
) {
  await canvas.findByLabelText("Workspace files")
  await waitFor(() => {
    expect(workspaceFilesText(canvas)).toMatch(pattern)
  })
}

const ledgerPath = "knowledge/billing/ledger.md"
const agentsPath = "AGENTS.md"
const longAgentsBody = [
  "# Docs workspace",
  "",
  ...Array.from(
    { length: 80 },
    (_, index) => `Line ${index + 1} of the workspace handbook.`,
  ),
  `Wide row ${"column ".repeat(80)}`.trimEnd(),
].join("\n")

function WorkspacePanePlayground(props: ComponentProps<typeof WorkspacePane>) {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { pane?: string }
  const searchPane = parsePane(search.pane)
  const [localPane, setLocalPane] = useState<ParsedPane | null>(null)
  const pane = localPane ?? searchPane ?? props.pane
  const [session, setSession] = useState<FileTabSession>(() => ({
    tabs: props.fileTabs,
    previewPath:
      props.previewPath ??
      (props.fileTabs.length === 1 ? (props.fileTabs[0] ?? null) : null),
  }))
  const [width, setWidth] = useState<number | null>(props.width)
  const [maximized, setMaximized] = useState(props.maximized)
  const [open, setOpen] = useState(true)
  // The page makes the publish state; this harness stands in for the page.
  const publish = useConversationPublish({
    orgSlug: props.orgSlug,
    conversationId: props.conversationId ?? "",
    workspaceId: props.workspace.id,
    title: props.conversationTitle,
    statusEnabled: Boolean(props.conversationId),
    pullEnabled: Boolean(props.conversationId),
  })
  const panePath = pane.kind === "file" ? pane.path : null
  const fileTabs = tabsIncludingPanePath(session.tabs, panePath)

  const setPane = (next: ParsedPane) => {
    setLocalPane(next)
    props.onPane(next)
    void navigate({
      to: "/$orgSlug/ws/$workspaceSlug",
      params: {
        orgSlug: props.orgSlug,
        workspaceSlug: props.workspace.slug,
      },
      search: { pane: serializePane(next) },
      replace: true,
    })
  }

  const openFile = (path: string, pin: boolean) => {
    setSession((current) => {
      const seeded = seedFileTabSession(current, panePath)
      return pin ? pinFile(seeded, path) : previewFile(seeded, path)
    })
    setPane({ kind: "file", path })
  }

  return (
    <>
      <div
        className={workspaceChatColumnClassName({ maximized, paneOpen: open })}
        inert={maximized}
      >
        <div className="flex h-full min-w-0 flex-1 flex-col gap-3 p-4">
          <p className="text-sm text-muted-foreground">Conversation</p>
          {open ? null : (
            <WorkspacePaneTriggers
              orgSlug={props.orgSlug}
              workspace={props.workspace}
              onOpen={(next) => {
                setPane(next)
                setOpen(true)
              }}
            />
          )}
        </div>
      </div>
      {open ? (
        <WorkspacePane
          {...props}
          cta={props.conversationId ? publish.chrome : null}
          pane={pane}
          width={width}
          maximized={maximized}
          fileTabs={fileTabs}
          previewPath={session.previewPath}
          onPane={setPane}
          onClose={() => {
            setMaximized(false)
            setOpen(false)
            props.onClose()
          }}
          onToggleMaximize={() => {
            setMaximized((value) => !value)
            props.onToggleMaximize()
          }}
          onRestoreConversation={() => {
            setMaximized(false)
            props.onRestoreConversation()
          }}
          onResize={(next) => {
            setWidth(next)
            props.onResize(next)
          }}
          onPreviewFile={(path) => {
            openFile(path, false)
            props.onPreviewFile(path)
          }}
          onPinFile={(path) => {
            openFile(path, true)
            props.onPinFile(path)
          }}
          onCloseFileTab={(path) => {
            setSession((current) => closeFileTab(current, path))
            if (pane.kind === "file" && pane.path === path) {
              setPane({ kind: "files" })
            }
            props.onCloseFileTab(path)
          }}
          onCloseActiveFile={() => {
            if (pane.kind === "file") {
              setSession((current) => closeFileTab(current, pane.path))
              setPane({ kind: "files" })
            }
            props.onCloseActiveFile()
          }}
        />
      ) : null}
    </>
  )
}

const meta = {
  title: "Components/Workspaces/Pane",
  component: WorkspacePane,
  render: (args) => <WorkspacePanePlayground {...args} />,
  decorators: [
    (Story) => (
      <div className="flex h-svh min-h-0 bg-zinc-950">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: "files",
    } satisfies StoryRouteParams,
  },
  beforeEach: () => {
    clearAllConversationGitTreeSnapshots()
  },
  args: {
    orgSlug: "acme",
    workspace: docsWorkspaceDetail,
    pane: { kind: "files" },
    fileTabs: [],
    previewPath: null,
    treeCollapsed: false,
    maximized: false,
    width: null,
    conversationTitle: "Repo layout",
    ...paneCallbacks,
  },
} satisfies Meta<typeof WorkspacePane>

export default meta

type Story = StoryObj<typeof meta>

/** Collapsed pane: the triggers stand alone in the chat header. */
export const Triggers: Story = {
  render: (args) => (
    <div className="flex h-full min-w-0 flex-1 items-start justify-end p-4">
      <WorkspacePaneTriggers
        orgSlug={args.orgSlug}
        workspace={args.workspace}
        onOpen={args.onPane}
        onExpand={args.onClose}
      />
    </div>
  ),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Graph" }))
    expect(args.onPane).toHaveBeenCalledWith({ kind: "graph" })
    // The triggers have no visible border.
    expect(canvas.getByRole("button", { name: "Files" })).toHaveClass(
      "border-transparent",
    )
  },
}

/** Hide, show, and maximize: the pane and the chat column change state at once. Only the small control that reverses the action fades in. */
export const HideShowMaximize: Story = {
  parameters: {
    msw: {
      handlers: {
        page: gitFilesHandlers,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByLabelText("Workspace files")
    await userEvent.click(canvas.getByRole("button", { name: "Maximize pane" }))
    expect(
      await canvas.findByRole("button", { name: "Show conversation" }),
    ).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Show conversation" }),
    )
    expect(
      await canvas.findByRole("button", { name: "Maximize pane" }),
    ).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Hide pane" }))
    // No exit animation: the pane unmounts in the same commit as the click.
    expect(canvas.queryByLabelText("Workspace files")).toBeNull()
    await userEvent.click(canvas.getByRole("button", { name: "Files" }))
    expect(await canvas.findByLabelText("Workspace files")).toBeVisible()
  },
}

export const Files: Story = {
  parameters: {
    msw: {
      handlers: {
        page: gitFilesHandlers,
      },
    },
  },
}

export const FilesLoading: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [workspaceGitTreeLoadingHandler()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const message = await canvas.findByText("Loading your files")
    await waitFor(() => expect(message).toBeVisible(), { timeout: 2000 })
  },
}

export const FilesEmpty: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [workspaceGitTreeHandler({ sha: "abc123def456", paths: [] })],
      },
    },
  },
}

export const FilePreview: Story = {
  args: {
    pane: { kind: "file", path: ledgerPath },
    fileTabs: [ledgerPath],
    previewPath: ledgerPath,
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: serializePane({ kind: "file", path: ledgerPath }),
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: gitFilesHandlers,
      },
    },
  },
}

export const FilePreviewLoading: Story = {
  args: {
    pane: { kind: "file", path: ledgerPath },
    fileTabs: [ledgerPath],
    previewPath: ledgerPath,
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: serializePane({ kind: "file", path: ledgerPath }),
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          workspaceGitTreeHandler(docsWorkspaceGitTree),
          workspaceGitBlobLoadingHandler(),
          workspaceGitStatusHandler(),
          workspaceFileJobHandler(),
        ],
      },
    },
  },
}

export const FilePreviewLong: Story = {
  args: {
    pane: { kind: "file", path: agentsPath },
    fileTabs: [agentsPath],
    previewPath: agentsPath,
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: serializePane({ kind: "file", path: agentsPath }),
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          workspaceGitTreeHandler(docsWorkspaceGitTree),
          workspaceGitBlobHandler({
            ...docsWorkspaceGitBlobs,
            [agentsPath]: longAgentsBody,
          }),
          workspaceGitStatusHandler(),
          workspaceFileJobHandler(),
        ],
      },
    },
  },
}

export const FileDiff: Story = {
  args: {
    pane: { kind: "file", path: ledgerPath },
    fileTabs: [ledgerPath],
    previewPath: ledgerPath,
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: serializePane({ kind: "file", path: ledgerPath }),
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: gitFilesHandlers,
      },
    },
  },
}

export const ReadOnly: Story = {
  args: {
    workspace: readOnlyWorkspaceDetail,
    pane: { kind: "file", path: "AGENTS.md" },
    fileTabs: ["AGENTS.md"],
    previewPath: "AGENTS.md",
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "handbook",
      pane: serializePane({ kind: "file", path: "AGENTS.md" }),
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: gitFilesHandlers,
      },
    },
  },
}

const manyFileTabs = [
  ...Array.from(
    { length: 14 },
    (_, index) => `knowledge/notes/meeting-notes-${index + 1}.md`,
  ),
  ledgerPath,
]

/** Many file tabs: the selected tab at the end of the strip scrolls into view. */
export const SelectedTabInView: Story = {
  tags: ["workspace-golden"],
  args: {
    pane: { kind: "file", path: ledgerPath },
    fileTabs: manyFileTabs,
    previewPath: null,
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: serializePane({ kind: "file", path: ledgerPath }),
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: gitFilesHandlers,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const tab = await canvas.findByRole("tab", { name: "ledger.md" })
    await expect(tab).toHaveAttribute("aria-selected", "true")
    const strip = tab.closest('[role="tablist"]') as HTMLElement
    await waitFor(() => {
      expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth)
      expect(tab.getBoundingClientRect().right).toBeLessThanOrEqual(
        strip.getBoundingClientRect().right + 1,
      )
    })
  },
}

/** Text tabs keep 12px side padding, active or idle; icon tabs are square. */
export const TextTabsKeepPadding: Story = {
  tags: ["workspace-golden"],
  args: {
    pane: { kind: "file", path: ledgerPath },
    fileTabs: [ledgerPath, "knowledge/notes/meeting-notes-1.md"],
    previewPath: null,
  },
  parameters: SelectedTabInView.parameters,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const active = await canvas.findByRole("tab", { name: "ledger.md" })
    const idle = await canvas.findByRole("tab", {
      name: "meeting-notes-1.md",
    })
    for (const tab of [active, idle]) {
      const style = getComputedStyle(tab)
      expect(style.paddingLeft).toBe("12px")
      expect(style.paddingRight).toBe("12px")
    }
    const files = await canvas.findByRole("tab", { name: "Files" })
    // The icon tab is square: 7px + 1px border + 16px icon on each side.
    expect(files.getBoundingClientRect().width).toBe(32)
  },
}

export const TreeCollapsed: Story = {
  args: {
    pane: { kind: "file", path: ledgerPath },
    fileTabs: [ledgerPath],
    previewPath: ledgerPath,
    treeCollapsed: true,
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: serializePane({ kind: "file", path: ledgerPath }),
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: gitFilesHandlers,
      },
    },
  },
}

export const Graph: Story = {
  args: { pane: { kind: "graph" } },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: "graph",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [workspaceGraphHandler()],
      },
    },
  },
}

export const GraphLoading: Story = {
  args: { pane: { kind: "graph" } },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: "graph",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [workspaceGraphLoadingHandler()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(await canvas.findByText("Loading graph")).toBeVisible()
    expect(canvas.queryAllByRole("presentation")).toHaveLength(0)
  },
}

const graphPaneRoute = {
  pattern: "orgWorkspace",
  orgSlug: "acme",
  workspaceSlug: "docs",
  pane: "graph",
} satisfies StoryRouteParams

const graphGets = { count: 0 }

/** The graph phase is pending: the pane waits and does not read the graph. */
export const GraphPhasePending: Story = {
  tags: ["workspace-golden"],
  args: {
    pane: { kind: "graph" },
    workspace: {
      ...docsWorkspaceDetail,
      hydratePhases: { graph: { kind: "pending" } },
    },
  },
  beforeEach: () => {
    graphGets.count = 0
  },
  parameters: {
    storyRoute: graphPaneRoute,
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+\/graph$/.test(
                new URL(request.url).pathname,
              ),
            () => {
              graphGets.count += 1
              return HttpResponse.json(
                { error: "Workspace graph projection is unavailable." },
                { status: 503 },
              )
            },
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      await canvas.findByText(
        "The graph opens when ctx| finishes reading this Workspace.",
      ),
    ).toBeVisible()
    const tab = canvas.getByRole("tab", { name: "Graph, building" })
    expect(tab.querySelector(".ctx-indexing-dot")).not.toBeNull()
    // A graph query that was turned on would fetch at mount. Give it time.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(canvas.queryByText("Could not load graph")).toBeNull()
    expect(graphGets.count).toBe(0)
  },
}

/** The graph phase failed: the pane shows plain copy, not the store error. */
export const GraphPhaseFailed: Story = {
  tags: ["workspace-golden"],
  args: {
    pane: { kind: "graph" },
    workspace: {
      ...docsWorkspaceDetail,
      hydratePhases: {
        graph: { kind: "failed" },
      },
    },
  },
  parameters: { storyRoute: graphPaneRoute },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(await canvas.findByText("Could not build graph")).toBeVisible()
    expect(
      canvas.getByText(
        "Could not build the graph. It builds again automatically.",
      ),
    ).toBeVisible()
    // The tab fades in for 100 ms when the pane mounts.
    await waitFor(() =>
      expect(canvas.getByRole("tab", { name: "Graph" })).toBeVisible(),
    )
  },
}

/**
 * The graph store lost a ready graph: the route answers building, the pane
 * shows the building state, and the graph opens when a later read has it.
 */
export const GraphLostRebuilds: Story = {
  tags: ["workspace-golden"],
  args: {
    pane: { kind: "graph" },
    workspace: {
      ...docsWorkspaceDetail,
      hydratePhases: { graph: { kind: "ready" } },
    },
  },
  beforeEach: () => {
    graphGets.count = 0
  },
  parameters: {
    storyRoute: graphPaneRoute,
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+\/graph$/.test(
                new URL(request.url).pathname,
              ),
            () => {
              graphGets.count += 1
              return graphGets.count === 1
                ? HttpResponse.json({ building: true }, { status: 202 })
                : HttpResponse.json(docsWorkspaceGraph)
            },
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      await canvas.findByText(
        "The graph opens when ctx| finishes reading this Workspace.",
      ),
    ).toBeVisible()
    expect(canvas.queryByText("Could not load graph")).toBeNull()
    await waitFor(
      () => {
        expect(
          canvas.queryByText(
            "The graph opens when ctx| finishes reading this Workspace.",
          ),
        ).toBeNull()
      },
      { timeout: 10_000 },
    )
    expect(graphGets.count).toBeGreaterThan(1)
    expect(canvas.queryByText("Could not load graph")).toBeNull()
  },
}

/** The graph phase is ready but the graph route fails: the route error shows. */
export const GraphPhaseReadyStoreUnavailable: Story = {
  tags: ["workspace-golden"],
  args: {
    pane: { kind: "graph" },
    workspace: {
      ...docsWorkspaceDetail,
      hydratePhases: { graph: { kind: "ready" } },
    },
  },
  parameters: {
    storyRoute: graphPaneRoute,
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+\/graph$/.test(
                new URL(request.url).pathname,
              ),
            () =>
              HttpResponse.json(
                { error: "Workspace graph projection is unavailable." },
                { status: 503 },
              ),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      await canvas.findByText("Could not load graph", undefined, {
        timeout: 15_000,
      }),
    ).toBeVisible()
    const tab = canvas.getByRole("tab", { name: "Graph" })
    expect(tab.querySelector(".ctx-indexing-dot")).toBeNull()
  },
}

/** Collapsed pane: the Graph trigger shows a busy dot while the graph builds. */
export const TriggersGraphBuilding: Story = {
  tags: ["workspace-golden"],
  args: {
    workspace: {
      ...docsWorkspaceDetail,
      hydratePhases: { graph: { kind: "pending" } },
    },
  },
  render: (args) => (
    <div className="flex h-full min-w-0 flex-1 items-start justify-end p-4">
      <WorkspacePaneTriggers
        orgSlug={args.orgSlug}
        workspace={args.workspace}
        onOpen={args.onPane}
      />
    </div>
  ),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = await canvas.findByRole("button", {
      name: "Graph, building",
    })
    expect(trigger.querySelector(".ctx-indexing-dot")).not.toBeNull()
    expect(
      canvas
        .getByRole("button", { name: "Files" })
        .querySelector(".ctx-indexing-dot"),
    ).toBeNull()
    await userEvent.click(trigger)
    expect(args.onPane).toHaveBeenCalledWith({ kind: "graph" })
  },
}

export const Settings: Story = {
  args: { pane: { kind: "settings" } },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: "settings",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [workspaceListHandler([docsWorkspace])],
      },
    },
  },
}

export const SettingsSkippedFileOpensInFiles: Story = {
  args: { pane: { kind: "settings" }, workspace: skippedFilesWorkspaceDetail },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: "settings",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [workspaceListHandler([docsWorkspace]), ...gitFilesHandlers],
      },
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("link", { name: "knowledge/billing/tax.md" }),
    )
    await expect(args.onPinFile).toHaveBeenCalledWith(
      "knowledge/billing/tax.md",
    )
    await canvas.findByRole("tab", { name: "tax.md", selected: true })
    await canvas.findByTitle("knowledge/billing/tax.md")
  },
}

export const Maximized: Story = {
  args: {
    pane: { kind: "files" },
    maximized: true,
  },
  parameters: {
    msw: {
      handlers: {
        page: gitFilesHandlers,
      },
    },
  },
}

const conversationFileHandlers = [
  conversationPrepareHandler(),
  conversationGitTreeHandler(),
  conversationGitBlobHandler(),
  conversationGitStatusHandler(),
  conversationGitDiffHandler(),
  conversationFilePutHandler(),
  ...gitFilesHandlers,
]

export const ConversationWritable: Story = {
  args: {
    conversationId: "conv_1",
    pane: { kind: "file", path: ledgerPath },
    fileTabs: [ledgerPath],
    previewPath: ledgerPath,
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
      pane: serializePane({ kind: "file", path: ledgerPath }),
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: conversationFileHandlers,
      },
    },
  },
}

export const ConversationSandboxFiles: Story = {
  tags: ["workspace-golden"],
  args: {
    conversationId: "conv_1",
    pane: { kind: "files" },
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
      pane: "files",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          conversationGitTreeHandler({
            sha: "sandboxsha",
            paths: ["e2e-session-branch-note.md", "AGENTS.md"],
            branch: "ctxpipe/chat/conv_1/1",
          }),
          conversationGitStatusHandler(),
          workspaceGitTreeHandler({
            sha: "workspace-only",
            paths: ["repositories/README.md"],
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectWorkspaceFiles(canvas, /e2e-session-branch-note/)
    // At a wide viewport the conversation header has Create PR, so the pane hides its copy.
    expect(
      canvas.queryByRole("button", { name: "Create PR" }),
    ).not.toBeInTheDocument()
    expect(canvas.queryByText("repositories")).not.toBeInTheDocument()
  },
}

/**
 * The pane is maximized, so the conversation header is hidden: the pane shows
 * Sync. When the conversation shows beside the pane, only it has
 * them.
 */
export const ConversationMaximizedSync: Story = {
  tags: ["workspace-golden"],
  args: {
    ...ConversationSandboxFiles.args,
    maximized: true,
  },
  parameters: ConversationSandboxFiles.parameters,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const sync = await canvas.findByRole("button", {
      name: "Sync: commit and push your changes",
    })
    expect(sync).toBeVisible()
    expect(sync).toHaveTextContent("Sync")
    // The branch is dirty, so Sync is the only CTA.
    expect(canvas.queryByRole("button", { name: "Create PR" })).toBeNull()
  },
}

export const ConversationCleanNoPublish: Story = {
  args: {
    conversationId: "conv_1",
    pane: { kind: "files" },
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
      pane: "files",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          conversationGitTreeHandler({
            sha: "sandboxsha",
            paths: ["AGENTS.md"],
            branch: "ctxpipe/chat/conv_1/1",
          }),
          conversationGitStatusHandler({
            source: "sandbox",
            branch: "ctxpipe/chat/conv_1/1",
            dirty: false,
            differsFromDefault: false,
            unpushed: false,
            published: true,
            ahead: 0,
            behind: 0,
            items: [],
            worktreeVersion: "wt-0",
          }),
          workspaceGitTreeHandler({
            sha: "workspace-only",
            paths: ["repositories/README.md"],
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectWorkspaceFileNamed(canvas, "AGENTS.md")
    expect(
      canvas.queryByRole("button", { name: /^Sync/, hidden: true }),
    ).not.toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create PR" }),
    ).not.toBeInTheDocument()
  },
}

/**
 * Maximized, so the pane header shows the conversation's Create PR. The
 * commits are on GitHub, so nothing is left to sync and Create PR is the CTA.
 */
export const ConversationCommittedCreatePr: Story = {
  args: {
    conversationId: "conv_1",
    pane: { kind: "files" },
    maximized: true,
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
      pane: "files",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          conversationGitTreeHandler({
            sha: "sandboxsha",
            paths: ["AGENTS.md"],
            branch: "ctxpipe/chat/conv_1/1",
          }),
          conversationGitStatusHandler({
            source: "sandbox",
            branch: "ctxpipe/chat/conv_1/1",
            dirty: false,
            differsFromDefault: true,
            unpushed: false,
            published: true,
            ahead: 1,
            behind: 0,
            items: [],
            worktreeVersion: "wt-0",
          }),
          workspaceGitTreeHandler({
            sha: "workspace-only",
            paths: ["repositories/README.md"],
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() => {
      expect(canvas.getByRole("button", { name: "Create PR" })).toBeVisible()
    })
  },
}

export const ConversationReadOnly: Story = {
  args: {
    workspace: readOnlyWorkspaceDetail,
    conversationId: "conv_1",
    pane: { kind: "files" },
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "handbook",
      conversationId: "conv_1",
      pane: "files",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          conversationGitTreeHandler({
            sha: "sandboxsha",
            paths: ["AGENTS.md"],
            branch: "ctxpipe/chat/conv_1/1",
          }),
          conversationGitStatusHandler(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectWorkspaceFileNamed(canvas, "AGENTS.md")
    expect(
      canvas.queryByRole("button", { name: /^Sync/, hidden: true }),
    ).not.toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create PR" }),
    ).not.toBeInTheDocument()
  },
}

export const DiffTab: Story = {
  args: {
    conversationId: "conv_1",
    pane: { kind: "diff" },
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
      pane: "diff",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: conversationFileHandlers,
      },
    },
  },
}

export const SandboxLoading: Story = {
  args: {
    conversationId: "conv_1",
    pane: { kind: "files" },
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
      pane: "files",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        // The Workspace has no indexed default branch to show yet.
        page: [
          conversationGitTreeMissingHandler(),
          workspaceGitTreeHandler({ sha: "", paths: [] }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(canvas.getByText("Loading your files")).toBeInTheDocument()
    expect(canvas.queryByText("knowledge")).not.toBeInTheDocument()
    expect(canvas.queryByText("repositories")).not.toBeInTheDocument()
  },
}

export const CachedSandboxWhile409: Story = {
  args: {
    conversationId: "conv_1",
    pane: { kind: "files" },
  },
  beforeEach: () => {
    writeConversationGitTreeSnapshot("conv_1", {
      sha: "cachedsha",
      paths: ["cached-note.md"],
      branch: "ctxpipe/chat/conv_1/1",
    })
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
      pane: "files",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          conversationGitTreeEventuallyHandler(
            {
              sha: "livesha",
              paths: ["e2e-live-note.md"],
              branch: "ctxpipe/chat/conv_1/1",
            },
            1,
          ),
          workspaceGitTreeHandler({
            sha: "workspace-only",
            paths: ["repositories/README.md"],
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectWorkspaceFileNamed(canvas, "cached-note.md")
    expect(canvas.queryByText("Updating…")).not.toBeInTheDocument()
    expect(workspaceFileNames(canvas)).not.toContain("repositories")
    await expectWorkspaceFileNamed(canvas, "e2e-live-note.md", 8000)
    expect(workspaceFileNames(canvas)).not.toContain("cached-note.md")
    expect(canvas.queryByText("Updating…")).not.toBeInTheDocument()
    expect(workspaceFileNames(canvas)).not.toContain("repositories")
  },
}

// The new conversation's sandbox starts when the story presses "Sandbox ready".
const startingSandbox = { ready: false }

const startingSandboxTreeHandler = http.get(
  ({ request }) =>
    /\/api\/v1\/conversations\/[^/]+\/files\/tree$/.test(
      new URL(request.url).pathname,
    ),
  () =>
    startingSandbox.ready
      ? HttpResponse.json({
          ...docsWorkspaceGitTree,
          paths: [...docsWorkspaceGitTree.paths, "sandbox-note.md"].sort(),
          branch: "ctxpipe/chat/conv_new/1",
          worktreeVersion: "wt-0",
        })
      : HttpResponse.json({ error: "missing_sandbox" }, { status: 409 }),
)

function StartingSandboxPlayground(
  props: ComponentProps<typeof WorkspacePane>,
) {
  const queryClient = useQueryClient()
  return (
    <>
      <Button
        variant="quiet"
        onPress={() => {
          startingSandbox.ready = true
          // The chat session sets this when the sandbox is ready.
          queryClient.setQueryData(
            workspaceKeys.chatPrepare(
              props.orgSlug,
              props.conversationId ?? "",
              props.workspace.id,
            ),
            null,
          )
        }}
      >
        Sandbox ready
      </Button>
      <WorkspacePanePlayground {...props} />
    </>
  )
}

/**
 * A new conversation shows the default branch until its sandbox is ready.
 * Then the sandbox tree replaces it, with the open folders and the open file.
 */
export const DefaultBranchUntilSandboxReady: Story = {
  tags: ["workspace-golden"],
  args: {
    conversationId: "conv_new",
    pane: { kind: "files" },
  },
  beforeEach: () => {
    startingSandbox.ready = false
    clearAllConversationGitTreeSnapshots()
  },
  render: (args) => <StartingSandboxPlayground {...args} />,
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_new",
      pane: "files",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          startingSandboxTreeHandler,
          conversationGitBlobHandler({
            ...docsWorkspaceGitBlobs,
            [ledgerPath]: "# Sandbox ledger\n",
          }),
          // A clean sandbox: no working body hides the sandbox blob.
          conversationGitStatusHandler({
            source: "sandbox",
            branch: "ctxpipe/chat/conv_new/1",
            dirty: false,
            differsFromDefault: false,
            unpushed: false,
            published: false,
            ahead: 0,
            behind: 0,
            items: [],
            worktreeVersion: "wt-0",
          }),
          conversationFilePutHandler(),
          ...gitFilesHandlers,
        ],
      },
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const row = (path: string) =>
      findInShadows(canvasElement, `button[data-item-path='${path}']`)
    const folder = (path: string) => row(`${path}/`) ?? row(path)
    await waitFor(() => {
      expect(folder("knowledge")).toBeTruthy()
    })
    expect(canvas.queryByText("Loading your files")).not.toBeInTheDocument()
    await userEvent.click(folder("knowledge") as HTMLElement)
    await waitFor(() => {
      expect(folder("knowledge/billing")).toBeTruthy()
    })
    await userEvent.click(folder("knowledge/billing") as HTMLElement)
    await waitFor(() => {
      expect(row(ledgerPath)).toBeTruthy()
    })
    await userEvent.click(row(ledgerPath) as HTMLElement)
    await expect(args.onPreviewFile).toHaveBeenCalledWith(ledgerPath)
    // Before the sandbox is ready the file comes from the default branch.
    await canvas.findByText(/You can edit when the sandbox is ready/)
    expect(canvas.queryByRole("button", { name: "Save" })).toBeNull()
    // The read-only file has no editor handle, so read the rendered text.
    await waitFor(() => {
      expect(textInShadows(pierreEditorHost(canvasElement))).toMatch(
        /Billing ledger/,
      )
    })

    await userEvent.click(canvas.getByRole("button", { name: "Sandbox ready" }))
    await waitFor(() => {
      expect(row("sandbox-note.md")).toBeTruthy()
    })
    // The open folders and the selected file stay.
    expect(row(ledgerPath)).toBeTruthy()
    expect(folder("knowledge/billing")).toHaveAttribute("aria-expanded", "true")
    expect(row(ledgerPath)).toHaveAttribute("aria-selected", "true")
    await waitFor(() => {
      expect(
        canvas.queryByText(/You can edit when the sandbox is ready/),
      ).not.toBeInTheDocument()
    })
    await canvas.findByRole("button", { name: "Save" })
    await waitFor(() => {
      expect(pierreEditorHost(canvasElement)?.getPierreText?.()).toMatch(
        /Sandbox ledger/,
      )
    })
  },
}

const filesTreeGets = { count: 0 }

export const StableFilesRequestBudget: Story = {
  tags: ["workspace-golden"],
  args: {
    conversationId: "conv_1",
    pane: { kind: "files" },
  },
  render: (args) => <WorkspacePanePlayground {...args} />,
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
      pane: "files",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/files\/tree$/.test(
                new URL(request.url).pathname,
              ),
            () => {
              filesTreeGets.count += 1
              return HttpResponse.json({
                sha: "livesha",
                paths: ["AGENTS.md", "e2e.md"],
                branch: "ctxpipe/chat/conv_1/1",
              })
            },
          ),
          conversationGitStatusHandler(),
          workspaceGitTreeHandler({
            sha: "workspace-only",
            paths: ["repositories/README.md"],
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectWorkspaceFiles(canvas, /AGENTS/)
    await waitFor(() => {
      expect(filesTreeGets.count).toBeGreaterThan(0)
    })
    const afterPaint = filesTreeGets.count
    await new Promise((resolve) => {
      window.setTimeout(resolve, 800)
    })
    expect(filesTreeGets.count).toBe(afterPaint)
    expect(canvas.queryByText("repositories")).not.toBeInTheDocument()
  },
}

function findInShadows(root: ParentNode, selector: string): Element | null {
  const direct = root.querySelector(selector)
  if (direct instanceof HTMLElement) return direct
  for (const element of root.querySelectorAll("*")) {
    if (!element.shadowRoot) continue
    const nested = findInShadows(element.shadowRoot, selector)
    if (nested) return nested
  }
  return null
}

/** The text of `node`, also the text inside each open shadow root. */
function textInShadows(node: Node | null): string {
  if (!node) return ""
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ""
  let text = ""
  if (node instanceof Element && node.shadowRoot)
    text += textInShadows(node.shadowRoot)
  for (const child of node.childNodes) text += textInShadows(child)
  return text
}

type PierreEditorHost = HTMLElement & {
  hasPierreEditor?: () => boolean
  getPierreText?: () => string
  insertPierreText?: (value: string) => void
}

function pierreEditorHost(canvasElement: HTMLElement): PierreEditorHost | null {
  return (findInShadows(canvasElement, "[data-workspace-file-editor]") ??
    canvasElement.querySelector(
      "[data-workspace-file-editor]",
    )) as PierreEditorHost | null
}

// userEvent types into document.activeElement, which is the shadow host, so
// its keys never reach Pierre's editor; the editor's own handle types instead.
async function typeInPierreEditor(canvasElement: HTMLElement, text: string) {
  await waitFor(
    () => {
      const host = pierreEditorHost(canvasElement)
      expect(host).toBeTruthy()
      expect(host?.hasPierreEditor?.()).toBe(true)
    },
    { timeout: 5_000 },
  )
  const host = pierreEditorHost(canvasElement)
  if (!host?.insertPierreText) {
    throw new Error("Pierre editor host was not found")
  }
  host.insertPierreText(text)
  await waitFor(
    () => {
      expect(host.getPierreText?.() ?? "").toContain(text)
    },
    { timeout: 5_000 },
  )
}

async function saveDirtyEditor(canvas: ReturnType<typeof within>) {
  const save = canvas.getByRole("button", { name: "Save" })
  if (
    !save.hasAttribute("disabled") &&
    save.getAttribute("data-disabled") !== "true"
  ) {
    await userEvent.click(save)
    return
  }
  await userEvent.keyboard("{Control>}s{/Control}")
}

const editThenNavigatePuts = {
  count: 0,
  paths: [] as string[],
  versions: [] as Array<string | undefined>,
  bodies: [] as string[],
}

function EditThenNavigateHarness(props: ComponentProps<typeof WorkspacePane>) {
  const [mounted, setMounted] = useState(true)
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex gap-2 p-2">
        <Button variant="secondary" onPress={() => setMounted(false)}>
          Leave files
        </Button>
      </div>
      {mounted ? <WorkspacePanePlayground {...props} /> : <p>Left files</p>}
    </div>
  )
}

export const EditThenNavigate: Story = {
  tags: ["workspace-golden"],
  args: {
    conversationId: "conv_1",
    pane: { kind: "file", path: ledgerPath },
    fileTabs: [ledgerPath],
    previewPath: ledgerPath,
  },
  render: (args) => <EditThenNavigateHarness {...args} />,
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
      pane: serializePane({ kind: "file", path: ledgerPath }),
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.put(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/files\/blob$/.test(
                new URL(request.url).pathname,
              ),
            async ({ request }) => {
              const body = (await request.json()) as {
                path: string
                body?: string
                expectedWorktreeVersion?: string
              }
              editThenNavigatePuts.count += 1
              editThenNavigatePuts.paths.push(body.path)
              editThenNavigatePuts.versions.push(body.expectedWorktreeVersion)
              editThenNavigatePuts.bodies.push(body.body ?? "")
              const worktreeVersion = "wt-1"
              return HttpResponse.json({
                path: body.path,
                body: body.body ?? null,
                binary: false,
                worktreeVersion,
                tree: {
                  sha: "sandboxsha",
                  paths: [body.path],
                  branch: "ctxpipe/chat/conv_1/1",
                  worktreeVersion,
                },
                status: {
                  source: "sandbox",
                  branch: "ctxpipe/chat/conv_1/1",
                  dirty: true,
                  differsFromDefault: true,
                  unpushed: true,
                  published: false,
                  ahead: 0,
                  behind: 0,
                  items: [{ path: body.path, status: "modified" }],
                  worktreeVersion,
                },
              })
            },
          ),
          conversationGitTreeHandler({
            sha: "sandboxsha",
            paths: [ledgerPath, "AGENTS.md"],
            branch: "ctxpipe/chat/conv_1/1",
            worktreeVersion: "wt-0",
          }),
          conversationGitBlobHandler(),
          conversationGitStatusHandler({
            source: "sandbox",
            branch: "ctxpipe/chat/conv_1/1",
            dirty: false,
            differsFromDefault: false,
            unpushed: false,
            published: false,
            ahead: 0,
            behind: 0,
            items: [],
            worktreeVersion: "wt-0",
          }),
          conversationGitDiffHandler(),
          ...gitFilesHandlers,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    editThenNavigatePuts.count = 0
    editThenNavigatePuts.paths = []
    editThenNavigatePuts.versions = []
    editThenNavigatePuts.bodies = []
    const canvas = within(canvasElement)
    await canvas.findByRole("button", { name: "Save" })
    await typeInPierreEditor(canvasElement, "dirty-leave-draft")
    expect(editThenNavigatePuts.count).toBe(0)
    await waitFor(() => {
      expect(canvas.getByRole("button", { name: "Save" })).not.toBeDisabled()
    })
    await userEvent.click(canvas.getByRole("button", { name: "Leave files" }))
    await waitFor(() => {
      expect(canvas.getByText("Left files")).toBeVisible()
    })
    await waitFor(() => {
      expect(editThenNavigatePuts.count).toBeGreaterThan(0)
    })
    expect(
      editThenNavigatePuts.paths.some((path) => path.includes(ledgerPath)),
    ).toBe(true)
    expect(editThenNavigatePuts.versions[0]).toBe("wt-0")
    expect(
      editThenNavigatePuts.bodies.some(
        (body) => body.includes("dirty-leave-draft") && body.length > 0,
      ),
    ).toBe(true)
  },
}

const newFilePath = "knowledge/billing/scratch.md"
const newFileText = "# Scratch notes\nFirst line of text.\nSecond line."
const newFileServer = {
  blobs: {} as Record<string, string>,
  puts: [] as Array<{ path: string; body: string }>,
  version: 0,
}

function newFileWriteResponse(path: string, body: string | null) {
  newFileServer.version += 1
  const worktreeVersion = `wt-${newFileServer.version}`
  const paths = [ledgerPath, "AGENTS.md", ...Object.keys(newFileServer.blobs)]
  return {
    path,
    body,
    binary: false,
    worktreeVersion,
    tree: {
      sha: "sandboxsha",
      paths: [...new Set(paths)],
      branch: "ctxpipe/chat/conv_1/1",
      worktreeVersion,
    },
    status: {
      source: "sandbox" as const,
      branch: "ctxpipe/chat/conv_1/1",
      dirty: true,
      differsFromDefault: true,
      unpushed: true,
      published: false,
      ahead: 0,
      behind: 0,
      items: Object.keys(newFileServer.blobs).map((item) => ({
        path: item,
        status: "added" as const,
      })),
      worktreeVersion,
    },
  }
}

export const NewFileKeepsTypedText: Story = {
  tags: ["workspace-golden"],
  args: {
    conversationId: "conv_1",
    pane: { kind: "file", path: ledgerPath },
    fileTabs: [ledgerPath],
    previewPath: ledgerPath,
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
      pane: serializePane({ kind: "file", path: ledgerPath }),
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.put(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/files\/blob$/.test(
                new URL(request.url).pathname,
              ),
            async ({ request }) => {
              const body = (await request.json()) as {
                path: string
                body?: string
              }
              newFileServer.puts.push({
                path: body.path,
                body: body.body ?? "",
              })
              newFileServer.blobs[body.path] = body.body ?? ""
              return HttpResponse.json(
                newFileWriteResponse(body.path, body.body ?? null),
              )
            },
          ),
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/files\/blob$/.test(
                new URL(request.url).pathname,
              ) &&
              new URL(request.url).searchParams.get("path") === newFilePath,
            () => {
              const body = newFileServer.blobs[newFilePath]
              if (body === undefined) {
                return HttpResponse.json(
                  { error: "Not found" },
                  { status: 404 },
                )
              }
              return HttpResponse.json({
                path: newFilePath,
                body,
                binary: false,
              })
            },
          ),
          conversationGitTreeHandler({
            sha: "sandboxsha",
            paths: [ledgerPath, "AGENTS.md"],
            branch: "ctxpipe/chat/conv_1/1",
            worktreeVersion: "wt-0",
          }),
          conversationGitBlobHandler(),
          conversationGitStatusHandler({
            source: "sandbox",
            branch: "ctxpipe/chat/conv_1/1",
            dirty: false,
            differsFromDefault: false,
            unpushed: false,
            published: false,
            ahead: 0,
            behind: 0,
            items: [],
            worktreeVersion: "wt-0",
          }),
          conversationGitDiffHandler(),
          ...gitFilesHandlers,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    newFileServer.blobs = {}
    newFileServer.puts = []
    newFileServer.version = 0
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("button", { name: "New file" }),
    )
    await userEvent.type(await page.findByLabelText("Name"), "scratch.md")
    await userEvent.click(page.getByRole("button", { name: "Create" }))
    await waitFor(() => {
      expect(newFileServer.puts).toEqual([{ path: newFilePath, body: "" }])
    })
    await canvas.findAllByText("scratch.md")
    await waitFor(() => {
      expect(pierreEditorHost(canvasElement)?.hasPierreEditor?.()).toBe(true)
      expect(pierreEditorHost(canvasElement)?.getPierreText?.()).toBe("")
    })
    // The first edit makes the text differ from the saved file. The editor
    // must stay the same element: a new one has no focus, so the next keys
    // the user types go nowhere (ticket 51, gap 3).
    const editable = () =>
      findInShadows(canvasElement, "[contenteditable='true']")
    const opened = editable() as HTMLElement | null
    expect(opened).toBeTruthy()
    const focused = () => {
      let active = canvasElement.ownerDocument.activeElement
      while (active?.shadowRoot?.activeElement)
        active = active.shadowRoot.activeElement
      return active
    }
    opened?.focus()
    await waitFor(() => expect(focused()).toBe(opened))
    const [firstLine = "", ...otherLines] = newFileText.split("\n")
    await typeInPierreEditor(canvasElement, firstLine)
    expect(editable()).toBe(opened)
    expect(focused()).toBe(opened)
    await typeInPierreEditor(canvasElement, `\n${otherLines.join("\n")}`)
    expect(editable()).toBe(opened)
    expect(focused()).toBe(opened)
    expect(pierreEditorHost(canvasElement)?.getPierreText?.()).toBe(newFileText)
    await userEvent.click(canvas.getByRole("button", { name: "Save" }))
    await waitFor(() => {
      expect(newFileServer.puts.at(-1)).toEqual({
        path: newFilePath,
        body: newFileText,
      })
    })
    expect(pierreEditorHost(canvasElement)?.getPierreText?.()).toBe(newFileText)
  },
}

const orderedWrites = {
  expected: [] as Array<string | undefined>,
  paths: [] as string[],
  server: "wt-0",
  accepted: 0,
  bodies: {} as Record<string, string>,
  inFlight: 0,
  maxInFlight: 0,
}

export const OutOfOrderSaves: Story = {
  tags: ["workspace-golden"],
  args: {
    conversationId: "conv_1",
    pane: { kind: "file", path: ledgerPath },
    fileTabs: [ledgerPath, agentsPath],
    previewPath: ledgerPath,
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
      pane: serializePane({ kind: "file", path: ledgerPath }),
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/files\/blob$/.test(
                new URL(request.url).pathname,
              ),
            ({ request }) => {
              const path = new URL(request.url).searchParams.get("path") ?? ""
              const body =
                orderedWrites.bodies[path] ?? docsWorkspaceGitBlobs[path]
              if (body === undefined) {
                return HttpResponse.json(
                  { error: "Not found" },
                  { status: 404 },
                )
              }
              return HttpResponse.json({ path, body, binary: false })
            },
          ),
          http.put(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/files\/blob$/.test(
                new URL(request.url).pathname,
              ),
            async ({ request }) => {
              const body = (await request.json()) as {
                path: string
                body?: string
                expectedWorktreeVersion?: string
              }
              orderedWrites.inFlight += 1
              orderedWrites.maxInFlight = Math.max(
                orderedWrites.maxInFlight,
                orderedWrites.inFlight,
              )
              try {
                orderedWrites.expected.push(body.expectedWorktreeVersion)
                orderedWrites.paths.push(body.path)
                if (body.expectedWorktreeVersion !== orderedWrites.server) {
                  return HttpResponse.json(
                    {
                      error: "stale_worktree",
                      worktreeVersion: orderedWrites.server,
                    },
                    { status: 409 },
                  )
                }
                const worktreeVersion = `wt-${orderedWrites.accepted + 1}`
                orderedWrites.accepted += 1
                orderedWrites.server = worktreeVersion
                orderedWrites.bodies[body.path] = body.body ?? ""
                if (orderedWrites.accepted === 1) {
                  await new Promise((resolve) => {
                    window.setTimeout(resolve, 2000)
                  })
                }
                return HttpResponse.json({
                  path: body.path,
                  body: body.body ?? null,
                  binary: false,
                  worktreeVersion,
                  tree: {
                    sha: "sandboxsha",
                    paths: [
                      ...new Set([
                        ledgerPath,
                        agentsPath,
                        ...orderedWrites.paths,
                      ]),
                    ],
                    branch: "ctxpipe/chat/conv_1/1",
                    worktreeVersion,
                  },
                  status: {
                    source: "sandbox",
                    branch: "ctxpipe/chat/conv_1/1",
                    dirty: true,
                    differsFromDefault: true,
                    unpushed: true,
                    published: false,
                    ahead: 0,
                    behind: 0,
                    items: orderedWrites.paths.map((path) => ({
                      path,
                      status: "added",
                    })),
                    worktreeVersion,
                  },
                })
              } finally {
                orderedWrites.inFlight -= 1
              }
            },
          ),
          conversationGitTreeHandler({
            sha: "sandboxsha",
            paths: [ledgerPath, "AGENTS.md"],
            branch: "ctxpipe/chat/conv_1/1",
            worktreeVersion: "wt-0",
          }),
          conversationGitBlobHandler(),
          conversationGitStatusHandler({
            source: "sandbox",
            branch: "ctxpipe/chat/conv_1/1",
            dirty: false,
            differsFromDefault: false,
            unpushed: false,
            published: false,
            ahead: 0,
            behind: 0,
            items: [],
            worktreeVersion: "wt-0",
          }),
          conversationGitDiffHandler(),
          ...gitFilesHandlers,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    orderedWrites.expected = []
    orderedWrites.paths = []
    orderedWrites.server = "wt-0"
    orderedWrites.accepted = 0
    orderedWrites.bodies = {}
    orderedWrites.inFlight = 0
    orderedWrites.maxInFlight = 0
    const canvas = within(canvasElement)
    await canvas.findByRole("button", { name: "Save" })
    await typeInPierreEditor(canvasElement, "ooo-save-one")
    await waitFor(() => {
      expect(canvas.getByRole("button", { name: "Save" })).not.toBeDisabled()
    })
    await saveDirtyEditor(canvas)
    await userEvent.click(canvas.getByRole("tab", { name: "AGENTS.md" }))
    await waitFor(
      () => {
        expect(
          pierreEditorHost(canvasElement)?.getPierreText?.() ?? "",
        ).toContain("Docs workspace")
      },
      { timeout: 5_000 },
    )
    await typeInPierreEditor(canvasElement, "ooo-save-two")
    await saveDirtyEditor(canvas)
    await waitFor(
      () => {
        expect(orderedWrites.paths).toContain(ledgerPath)
        expect(orderedWrites.paths).toContain(agentsPath)
        expect(orderedWrites.accepted).toBeGreaterThanOrEqual(2)
        expect(orderedWrites.maxInFlight).toBeGreaterThanOrEqual(2)
      },
      { timeout: 8_000 },
    )
    expect(orderedWrites.expected[0]).toBe("wt-0")
    expect(orderedWrites.server).toMatch(/^wt-\d+$/)
    expect(orderedWrites.bodies[ledgerPath]).toContain("ooo-save-one")
    expect(orderedWrites.bodies[agentsPath]).toContain("ooo-save-two")
    expect(orderedWrites.bodies[ledgerPath]).not.toBe(
      orderedWrites.bodies[agentsPath],
    )
    expect(canvas.queryByText("Could not save")).toBeNull()
    expect(canvas.queryByText("File not found")).toBeNull()
    expect(canvas.queryByText("Duplicate path")).toBeNull()
  },
}
