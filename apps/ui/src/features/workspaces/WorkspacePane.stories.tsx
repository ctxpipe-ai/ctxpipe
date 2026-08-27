import type { Meta, StoryObj } from "@storybook/react-vite"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { type ComponentProps, useState } from "react"
import { expect, fn, waitFor, within } from "storybook/test"
import {
  conversationFilePutHandler,
  conversationGitBlobHandler,
  conversationGitDiffHandler,
  conversationGitStatusHandler,
  conversationGitTreeEventuallyHandler,
  conversationGitTreeHandler,
  conversationGitTreeLivePollHandler,
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
  closeFileTab,
  type FileTabSession,
  pinFile,
  previewFile,
  seedFileTabSession,
  tabsIncludingPanePath,
} from "./fileTabs"
import {
  clearAllConversationGitTreeSnapshots,
  writeConversationGitTreeSnapshot,
} from "./conversation-git-tree-snapshot"
import { type ParsedPane, parsePane, serializePane } from "./pane"
import { workspaceKeys } from "./queries"
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

function LiveChatFilesPlayground(props: ComponentProps<typeof WorkspacePane>) {
  const queryClient = useQueryClient()
  queryClient.setQueryData(
    workspaceKeys.conversationChatLive("acme", "conv_1"),
    true,
  )
  return <WorkspacePanePlayground {...props} />
}

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
    await waitFor(() => {
      expect(canvas.getByText("e2e-session-branch-note.md")).toBeVisible()
    })
    expect(canvas.queryByText("repositories")).not.toBeInTheDocument()
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
    expect(canvas.getByText("Updating…")).toBeVisible()
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

export const ConversationSandboxLivePoll: Story = {
  args: {
    conversationId: "conv_1",
    pane: { kind: "files" },
  },
  render: (args) => <LiveChatFilesPlayground {...args} />,
  beforeEach: () => {
    writeConversationGitTreeSnapshot("conv_1", {
      sha: "cachedsha",
      paths: ["AGENTS.md"],
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
          conversationGitTreeLivePollHandler({
            first: {
              sha: "cachedsha",
              paths: ["AGENTS.md"],
              branch: "ctxpipe/chat/conv_1/1",
            },
            next: {
              sha: "livesha",
              paths: ["AGENTS.md", "e2e.md"],
              branch: "ctxpipe/chat/conv_1/1",
            },
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
    await waitFor(() => {
      expect(canvas.getByText("AGENTS.md")).toBeVisible()
    })
    expect(canvas.queryByText("repositories")).not.toBeInTheDocument()
    await waitFor(
      () => {
        expect(canvas.getByText("e2e.md")).toBeVisible()
      },
      { timeout: 3000 },
    )
    expect(canvas.queryByText("repositories")).not.toBeInTheDocument()
  },
}
