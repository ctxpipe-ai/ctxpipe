import type { Meta, StoryObj } from "@storybook/react-vite"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { HttpResponse, http, passthrough } from "msw"
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
import { WorkspacePane } from "./WorkspacePane"
import {
  docsWorkspace,
  docsWorkspaceDetail,
  docsWorkspaceGitBlobs,
  docsWorkspaceGitTree,
  readOnlyWorkspaceDetail,
} from "./workspace-fixtures"

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
    <WorkspacePane
      {...props}
      pane={pane}
      width={width}
      fileTabs={fileTabs}
      previewPath={session.previewPath}
      onPane={setPane}
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
  )
}

const meta = {
  title: "Components/Workspaces/Pane",
  component: WorkspacePane,
  render: (args) => <WorkspacePanePlayground {...args} />,
  decorators: [
    (Story, context) => (
      <div className="flex h-svh min-h-0 bg-zinc-950">
        {context.args.maximized ? null : (
          <div className="flex h-full min-w-0 flex-1 flex-col p-4">
            <p className="text-sm text-muted-foreground">Conversation</p>
          </div>
        )}
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
    expect(canvas.getByRole("button", { name: "Commit+Push" })).toBeVisible()
    expect(canvas.getByRole("button", { name: "Create PR" })).toBeVisible()
    expect(canvas.queryByText("repositories")).not.toBeInTheDocument()
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
    await waitFor(() => {
      expect(canvas.getByText("AGENTS.md")).toBeVisible()
    })
    expect(
      canvas.queryByRole("button", { name: "Commit+Push" }),
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
        page: [conversationGitTreeMissingHandler(), ...gitFilesHandlers],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(canvas.getByText("Loading files")).toBeInTheDocument()
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
            2,
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
    await waitFor(() => {
      expect(canvas.getByText("cached-note.md")).toBeVisible()
    })
    expect(canvas.queryByText("Updating…")).not.toBeInTheDocument()
    expect(canvas.queryByText("repositories")).not.toBeInTheDocument()
    await waitFor(
      () => {
        expect(canvas.getByText("e2e-live-note.md")).toBeVisible()
      },
      { timeout: 8000 },
    )
    expect(canvas.queryByText("cached-note.md")).not.toBeInTheDocument()
    expect(canvas.queryByText("Updating…")).not.toBeInTheDocument()
    expect(canvas.queryByText("repositories")).not.toBeInTheDocument()
  },
}

const filesTreeGets = { count: 0 }

export const StableFilesRequestBudget: Story = {
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
    expect(
      await canvas.findByRole("button", { name: "Commit+Push" }),
    ).toBeVisible()
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

async function createFileFromTree(
  canvas: ReturnType<typeof within>,
  canvasElement: HTMLElement,
  name: string,
) {
  await userEvent.click(await canvas.findByRole("button", { name: "New file" }))
  const page = within(canvasElement.ownerDocument.body)
  await userEvent.type(await page.findByLabelText("Name"), name)
  await userEvent.click(page.getByRole("button", { name: "Create" }))
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

async function typeInPierreEditor(canvasElement: HTMLElement, text: string) {
  await waitFor(() => {
    const editable =
      findInShadows(canvasElement, "[contenteditable='true']") ??
      findInShadows(canvasElement, ".cm-content") ??
      findInShadows(canvasElement, "textarea")
    expect(editable).toBeTruthy()
  })
  const editable = (findInShadows(canvasElement, "[contenteditable='true']") ??
    findInShadows(canvasElement, ".cm-content") ??
    findInShadows(canvasElement, "textarea")) as HTMLElement
  editable.focus()
  await userEvent.click(editable)
  await userEvent.type(editable, text)
}

const editThenNavigatePuts = {
  count: 0,
  paths: [] as string[],
  versions: [] as Array<string | undefined>,
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
    const canvas = within(canvasElement)
    await canvas.findByRole("button", { name: "Save" })
    await typeInPierreEditor(canvasElement, "dirty-leave-draft")
    expect(editThenNavigatePuts.count).toBe(0)
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
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/files\/blob$/.test(
                new URL(request.url).pathname,
              ),
            ({ request }) => {
              const path = new URL(request.url).searchParams.get("path") ?? ""
              if (path in orderedWrites.bodies) {
                return HttpResponse.json({
                  path,
                  body: orderedWrites.bodies[path],
                  binary: false,
                })
              }
              return passthrough()
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
                orderedWrites.bodies[body.path] = body.body ?? ""
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
                    paths: [...orderedWrites.paths],
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
    await createFileFromTree(canvas, canvasElement, "xdraftone.md")
    await waitFor(() => {
      expect(
        canvasElement.ownerDocument.body.querySelector('[role="dialog"]'),
      ).toBeNull()
    })
    await createFileFromTree(canvas, canvasElement, "xdrafttwo.md")
    await waitFor(
      () => {
        expect(orderedWrites.paths).toContain("knowledge/billing/xdraftone.md")
        expect(orderedWrites.paths).toContain("knowledge/billing/xdrafttwo.md")
        expect(orderedWrites.accepted).toBeGreaterThanOrEqual(2)
        expect(orderedWrites.maxInFlight).toBeGreaterThanOrEqual(2)
      },
      { timeout: 8_000 },
    )
    expect(orderedWrites.expected[0]).toBe("wt-0")
    expect(orderedWrites.server).toMatch(/^wt-\d+$/)
    expect(orderedWrites.bodies["knowledge/billing/xdraftone.md"]).toBeDefined()
    expect(orderedWrites.bodies["knowledge/billing/xdrafttwo.md"]).toBeDefined()
    expect(canvas.queryByText("Could not save")).toBeNull()
    expect(canvas.queryByText("File not found")).toBeNull()
  },
}
