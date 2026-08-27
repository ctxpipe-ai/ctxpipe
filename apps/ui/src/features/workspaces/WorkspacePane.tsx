import {
  IconAffiliate,
  IconAlertCircle,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconArrowsDiagonal2,
  IconArrowsDiagonalMinimize,
  IconDeviceFloppy,
  IconFolder,
  IconGitCompare,
  IconLayoutSidebarLeftExpand,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconSettings,
  IconX,
} from "@tabler/icons-react"
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { useParams } from "@tanstack/react-router"
import type { CSSProperties, ReactNode } from "react"
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Heading,
  type Key,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from "react-aria-components"
import { OverlayNavMenuButton } from "@/components/OverlayNavButton"
import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Modal } from "@/components/ui/Modal"
import { TextField } from "@/components/ui/TextField"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { useUrgentValue } from "@/lib/useUrgentValue"
import { cn } from "@/lib/utils"
import { conversationAllowsEdits } from "./conversationPublish"
import { joinFileName, optimisticPathsAfterJob } from "./fileTreeMutations"
import { filePaneId, type ParsedPane, parsePane, serializePane } from "./pane"
import {
  conversationGitBlobOptions,
  conversationGitDiffOptions,
  conversationGitStatusOptions,
  conversationGitTreeOptions,
  persistConversationFileMutation,
  workspaceChatPrepareOptions,
  workspaceGitBlobOptions,
  workspaceGitStatusOptions,
  workspaceGitTreeOptions,
  workspaceGraphOptions,
  workspaceKeys,
} from "./queries"
import type {
  ConversationGitDiffItem,
  WorkspaceDetail,
  WorkspaceFileJobRequest,
  WorkspaceGitStatusItem,
  WorkspaceGitTreeResponse,
} from "./types"
import {
  WorkspaceFileTree,
  type WorkspaceFileTreeItem,
} from "./WorkspaceFileTree"
import { WorkspaceGraphPane } from "./WorkspaceGraphPane"
import {
  type FileEditorHandle,
  type FileEditorHistory,
  WorkspacePierreFile,
} from "./WorkspacePierreFile"
import { WorkspaceSettingsPane } from "./WorkspaceSettingsPane"
import {
  workspaceChromeCardPaneClassName,
  workspaceChromeIconTabClassName,
  workspaceChromeOuterClassName,
  workspaceChromeOuterFlushClassName,
  workspaceChromeTabClassName,
  workspaceChromeTabIdleClassName,
  workspaceChromeTabStripClassName,
} from "./workspaceChrome"
import {
  WorkspaceFilePreviewSkeleton,
  WorkspaceFilesPaneSkeleton,
} from "./workspaceSkeletons"

export function WorkspacePane(props: {
  orgSlug: string
  workspace: WorkspaceDetail
  conversationId?: string
  pane: ParsedPane
  fileTabs: string[]
  previewPath: string | null
  treeCollapsed: boolean
  maximized: boolean
  width: number | null
  onPane: (pane: ParsedPane) => void
  onClose: () => void
  onToggleMaximize: () => void
  onRestoreConversation: () => void
  onResize: (width: number) => void
  onPreviewFile: (path: string) => void
  onPinFile: (path: string) => void
  onCloseFileTab: (path: string) => void
  onCloseActiveFile: () => void
  onToggleTree: () => void
  conversationTitle: string
}) {
  const queryClient = useQueryClient()
  const urlPaneKey = serializePane(props.pane)
  const [pane, setPane] = useUrgentValue(props.pane, urlPaneKey)
  const activeFile = pane.kind === "file" ? pane.path : null
  const filesTabActive = pane.kind === "files" || pane.kind === "diff"
  const selectedKey = serializePane(pane)
  const paneWidthLocked = props.width != null

  const prefetchPane = (next: ParsedPane) => {
    prefetchWorkspacePane(
      queryClient,
      props.orgSlug,
      props.workspace,
      next,
      props.conversationId,
    )
  }

  const selectPane = (next: ParsedPane) => {
    setPane(next)
    prefetchPane(next)
    props.onPane(next)
  }

  const onSelectTab = (key: Key | null) => {
    if (key == null) return
    const next = parsePane(String(key))
    if (!next) return
    selectPane(next)
  }
  const fileTabListRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = fileTabListRef.current
    if (!node) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return
      const target = event.target instanceof Element ? event.target : null
      const key =
        target?.closest("[data-key]")?.getAttribute("data-key") ??
        target?.closest("[id]")?.id
      if (!key) return
      const path = props.fileTabs.find((item) => filePaneId(item) === key)
      if (!path) return
      event.preventDefault()
      props.onCloseFileTab(path)
    }
    node.addEventListener("keydown", onKeyDown)
    return () => node.removeEventListener("keydown", onKeyDown)
  }, [props.fileTabs, props.onCloseFileTab])

  return (
    <aside
      className={cn(
        workspaceChromeOuterClassName,
        workspaceChromeOuterFlushClassName,
        "relative flex h-full min-h-0 pl-0 pr-3",
        props.maximized || !paneWidthLocked
          ? "min-w-0 flex-1"
          : "w-[var(--workspace-pane-width)] max-lg:min-w-0 max-lg:w-auto max-lg:flex-1 shrink-0",
      )}
      style={
        props.maximized || !paneWidthLocked
          ? undefined
          : ({
              "--workspace-pane-width": `${props.width}px`,
            } as CSSProperties)
      }
      data-workspace-surface=""
    >
      {props.maximized ? null : (
        <button
          type="button"
          aria-label="Resize pane"
          className={cn(
            "absolute bottom-[20px] left-[0.5px] z-20 hidden w-3 -translate-x-1/2 cursor-col-resize border-0 bg-transparent p-0 lg:block",
            filesTabActive ? "top-[16px]" : "top-[calc(16px+37px)]",
            "after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2",
            "after:rounded-full after:bg-transparent after:transition-colors",
            "hover:after:bg-white/40 focus-visible:after:bg-white/40",
          )}
          onPointerDown={(event) => {
            event.preventDefault()
            const startX = event.clientX
            const aside = event.currentTarget.closest("aside")
            const startWidth =
              props.width ?? aside?.getBoundingClientRect().width ?? 480
            const maxWidth = Math.max(480, window.innerWidth - 280)
            const move = (next: PointerEvent) => {
              props.onResize(
                Math.min(
                  maxWidth,
                  Math.max(280, startWidth + (startX - next.clientX)),
                ),
              )
            }
            const up = () => {
              window.removeEventListener("pointermove", move)
              window.removeEventListener("pointerup", up)
            }
            window.addEventListener("pointermove", move)
            window.addEventListener("pointerup", up)
          }}
        />
      )}

      <Tabs
        selectedKey={selectedKey}
        onSelectionChange={onSelectTab}
        className="flex h-full min-h-0 flex-1 flex-col"
        aria-label="Workspace tools"
      >
        <TooltipProvider delay={200}>
          <div
            className={cn(
              workspaceChromeTabStripClassName,
              "max-md:pl-1 max-md:pr-2",
            )}
          >
            <div className="mb-px flex shrink-0 self-end pb-0.5 md:hidden">
              <OverlayNavMenuButton />
            </div>
            <Button
              variant="ghost"
              onPress={props.onRestoreConversation}
              className={cn(
                workspaceChromeTabIdleClassName,
                "max-w-[min(100%,24rem)]",
                props.maximized ? "flex" : "hidden max-lg:flex",
              )}
            >
              <span className="truncate">{props.conversationTitle}</span>
            </Button>
            <TabList
              ref={fileTabListRef}
              className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
            >
              <PaneIconTab
                id="files"
                label="Files"
                icon={<IconFolder stroke={1.6} aria-hidden />}
                onIntent={() => prefetchPane({ kind: "files" })}
              />
              {props.conversationId ? (
                <ConversationDiffTab
                  orgSlug={props.orgSlug}
                  conversationId={props.conversationId}
                  workspaceId={props.workspace.id}
                  onIntent={() => prefetchPane({ kind: "diff" })}
                />
              ) : null}
              <PaneIconTab
                id="graph"
                label="Graph"
                icon={<IconAffiliate stroke={1.6} aria-hidden />}
                onIntent={() => prefetchPane({ kind: "graph" })}
              />
              <PaneIconTab
                id="settings"
                label="Settings"
                icon={<IconSettings stroke={1.6} aria-hidden />}
              />
              {props.fileTabs.map((path) => {
                const title = path.split("/").pop() ?? path
                const id = filePaneId(path)
                return (
                  <Tab
                    key={id}
                    id={id}
                    aria-label={title}
                    className={({ isSelected }) =>
                      cn(
                        "max-w-[12rem] gap-1",
                        isSelected
                          ? workspaceChromeTabClassName
                          : workspaceChromeTabIdleClassName,
                        focusVisibleClassName,
                      )
                    }
                  >
                    <span
                      className={cn(
                        "truncate font-mono",
                        props.previewPath === path && "italic",
                      )}
                    >
                      {title}
                    </span>
                    <span
                      aria-hidden
                      className="rounded p-0.5 hover:bg-zinc-700"
                      onPointerDown={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                      }}
                      onClick={(event) => {
                        event.stopPropagation()
                        props.onCloseFileTab(path)
                      }}
                    >
                      <IconX className="size-3" aria-hidden />
                    </span>
                  </Tab>
                )
              })}
            </TabList>
            <div className="flex shrink-0 items-end gap-0.5">
              <HeaderIcon
                label={props.maximized ? "Show conversation" : "Maximise pane"}
                icon={
                  props.maximized ? (
                    <IconArrowsDiagonalMinimize stroke={1.6} aria-hidden />
                  ) : (
                    <IconArrowsDiagonal2 stroke={1.6} aria-hidden />
                  )
                }
                onClick={props.onToggleMaximize}
                className="hidden lg:inline-flex"
              />
              <HeaderIcon
                label="Hide pane"
                icon={
                  <IconLayoutSidebarRightCollapse stroke={1.6} aria-hidden />
                }
                onClick={props.onClose}
              />
            </div>
          </div>
        </TooltipProvider>

        <TabPanel
          id={selectedKey}
          className={cn(
            workspaceChromeCardPaneClassName,
            // Square the join only when Files is the first strip item (split
            // view). Maximised / max-lg put conversation in that slot.
            filesTabActive && !props.maximized && "lg:rounded-tl-none",
            "flex min-h-0 p-0 outline-0",
          )}
        >
          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
            {pane.kind === "files" || pane.kind === "file" ? (
              <Suspense fallback={<WorkspaceFilesPaneSkeleton />}>
                <WorkspaceFilesPaneBody
                  orgSlug={props.orgSlug}
                  workspaceSlug={props.workspace.slug}
                  conversationId={props.conversationId}
                  sha={
                    props.workspace.activeProjectionSha?.trim() ||
                    props.workspace.desiredSha?.trim() ||
                    ""
                  }
                  writeStatus={props.workspace.writeStatus}
                  activeFile={activeFile}
                  treeCollapsed={props.treeCollapsed}
                  onPreviewFile={(path) => {
                    setPane({ kind: "file", path })
                    props.onPreviewFile(path)
                  }}
                  onPinFile={(path) => {
                    setPane({ kind: "file", path })
                    props.onPinFile(path)
                  }}
                  onToggleTree={props.onToggleTree}
                  onCloseActiveFile={props.onCloseActiveFile}
                />
              </Suspense>
            ) : null}
            {pane.kind === "diff" && props.conversationId ? (
              <Suspense fallback={<WorkspaceFilesPaneSkeleton />}>
                <WorkspaceConversationDiffPane
                  orgSlug={props.orgSlug}
                  conversationId={props.conversationId}
                  onOpenFile={(path) => {
                    setPane({ kind: "file", path })
                    props.onPinFile(path)
                  }}
                />
              </Suspense>
            ) : null}
            {pane.kind === "graph" ? (
              <Suspense
                fallback={
                  <WorkspaceGraphPane
                    orgSlug={props.orgSlug}
                    workspaceSlug={props.workspace.slug}
                    graph={undefined}
                    pending
                    onOpenSource={(path) => {
                      setPane({ kind: "file", path })
                      props.onPinFile(path)
                    }}
                  />
                }
              >
                <WorkspaceGraphPaneBody
                  orgSlug={props.orgSlug}
                  workspaceSlug={props.workspace.slug}
                  onOpenSource={(path) => {
                    setPane({ kind: "file", path })
                    props.onPinFile(path)
                  }}
                />
              </Suspense>
            ) : null}
            {pane.kind === "settings" ? (
              <WorkspaceSettingsPane
                orgSlug={props.orgSlug}
                workspace={props.workspace}
              />
            ) : null}
            {pane.kind === "unknown" ? (
              <div className="flex flex-1 items-center justify-center p-6">
                <p className="text-sm text-muted-foreground">
                  This pane id is kept in the URL and ignored.
                </p>
              </div>
            ) : null}
          </div>
        </TabPanel>
      </Tabs>
    </aside>
  )
}

function WorkspaceFilesPaneBody(props: {
  orgSlug: string
  workspaceSlug: string
  conversationId?: string
  sha: string
  writeStatus: string
  activeFile: string | null
  treeCollapsed: boolean
  onPreviewFile: (path: string) => void
  onPinFile: (path: string) => void
  onToggleTree: () => void
  onCloseActiveFile: () => void
}) {
  const routeConversationId = useParams({ strict: false }).conversationId
  const conversationId =
    props.conversationId ??
    (typeof routeConversationId === "string" ? routeConversationId : undefined)
  if (conversationId) {
    return (
      <ConversationSandboxFilesPane
        orgSlug={props.orgSlug}
        workspaceSlug={props.workspaceSlug}
        conversationId={conversationId}
        sha={props.sha}
        writeStatus={props.writeStatus}
        activeFile={props.activeFile}
        treeCollapsed={props.treeCollapsed}
        onPreviewFile={props.onPreviewFile}
        onPinFile={props.onPinFile}
        onToggleTree={props.onToggleTree}
        onCloseActiveFile={props.onCloseActiveFile}
      />
    )
  }
  return (
    <WorkspaceProjectionFilesPane
      orgSlug={props.orgSlug}
      workspaceSlug={props.workspaceSlug}
      sha={props.sha}
      activeFile={props.activeFile}
      treeCollapsed={props.treeCollapsed}
      onPreviewFile={props.onPreviewFile}
      onPinFile={props.onPinFile}
      onToggleTree={props.onToggleTree}
      onCloseActiveFile={props.onCloseActiveFile}
    />
  )
}

function ConversationSandboxFilesPane(props: {
  orgSlug: string
  workspaceSlug: string
  conversationId: string
  sha: string
  writeStatus: string
  activeFile: string | null
  treeCollapsed: boolean
  onPreviewFile: (path: string) => void
  onPinFile: (path: string) => void
  onToggleTree: () => void
  onCloseActiveFile: () => void
}) {
  const sandboxTreeQuery = useQuery({
    ...conversationGitTreeOptions(props.orgSlug, props.conversationId),
    refetchInterval: (query) => (query.state.data ? false : 2000),
  })
  const sandboxStatusQuery = useQuery({
    ...conversationGitStatusOptions(props.orgSlug, props.conversationId),
    enabled: sandboxTreeQuery.isSuccess,
  })
  if (!sandboxTreeQuery.data) {
    if (sandboxTreeQuery.isError && !sandboxTreeQuery.isFetching) {
      return (
        <div className="flex flex-1 items-center justify-center p-6">
          <InlineAlert variant="error" title="Could not load files">
            The conversation sandbox is not ready. Try again in a moment.
          </InlineAlert>
        </div>
      )
    }
    return <WorkspaceFilesPaneSkeleton />
  }
  return (
    <div className="h-full min-h-0 min-w-0 flex-1">
      <WorkspaceFilesPaneContent
        orgSlug={props.orgSlug}
        workspaceSlug={props.workspaceSlug}
        conversationId={props.conversationId}
        sha={props.sha}
        tree={sandboxTreeQuery.data}
        gitStatus={sandboxStatusQuery.data?.items ?? []}
        writable={conversationAllowsEdits(props.writeStatus)}
        activeFile={props.activeFile}
        treeCollapsed={props.treeCollapsed}
        onPreviewFile={props.onPreviewFile}
        onPinFile={props.onPinFile}
        onToggleTree={props.onToggleTree}
        onCloseActiveFile={props.onCloseActiveFile}
      />
    </div>
  )
}

function WorkspaceProjectionFilesPane(props: {
  orgSlug: string
  workspaceSlug: string
  sha: string
  activeFile: string | null
  treeCollapsed: boolean
  onPreviewFile: (path: string) => void
  onPinFile: (path: string) => void
  onToggleTree: () => void
  onCloseActiveFile: () => void
}) {
  const workspaceTree = useSuspenseQuery(
    workspaceGitTreeOptions(props.orgSlug, props.workspaceSlug, props.sha),
  )
  const workspaceStatusQuery = useQuery(
    workspaceGitStatusOptions(props.orgSlug, props.workspaceSlug, props.sha),
  )
  return (
    <div className="h-full min-h-0 min-w-0 flex-1">
      <WorkspaceFilesPaneContent
        orgSlug={props.orgSlug}
        workspaceSlug={props.workspaceSlug}
        sha={props.sha}
        tree={workspaceTree.data}
        gitStatus={workspaceStatusQuery.data?.items ?? []}
        writable={false}
        activeFile={props.activeFile}
        treeCollapsed={props.treeCollapsed}
        onPreviewFile={props.onPreviewFile}
        onPinFile={props.onPinFile}
        onToggleTree={props.onToggleTree}
        onCloseActiveFile={props.onCloseActiveFile}
      />
    </div>
  )
}

const FILES_HEADER_ICON_BUTTON_CLASS =
  "size-6 min-h-6 min-w-6 p-0 leading-none [&_svg]:block"
const TREE_WIDTH_MIN = 140
const TREE_WIDTH_MAX = 360
const TREE_WIDTH_DEFAULT = 208

function clampTreeWidth(width: number): number {
  return Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, width))
}

function WorkspaceFilesPaneContent(props: {
  orgSlug: string
  workspaceSlug: string
  conversationId?: string
  sha: string
  tree: WorkspaceGitTreeResponse
  gitStatus: readonly WorkspaceGitStatusItem[]
  writable: boolean
  activeFile: string | null
  treeCollapsed: boolean
  onPreviewFile: (path: string) => void
  onPinFile: (path: string) => void
  onToggleTree: () => void
  onCloseActiveFile: () => void
}) {
  const queryClient = useQueryClient()
  const prefetchBlob = (path: string) => {
    if (props.conversationId) {
      void queryClient.prefetchQuery(
        conversationGitBlobOptions(props.orgSlug, props.conversationId, path),
      )
      return
    }
    void queryClient.prefetchQuery(
      workspaceGitBlobOptions(
        props.orgSlug,
        props.workspaceSlug,
        props.sha,
        path,
      ),
    )
  }
  const writable = props.writable
  const [treeWidth, setTreeWidth] = useState(TREE_WIDTH_DEFAULT)
  const [treeResizing, setTreeResizing] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [createDialog, setCreateDialog] = useState<{
    kind: "file" | "folder"
    parentPath: string | null
  } | null>(null)
  const [createName, setCreateName] = useState("")
  const [deleteItem, setDeleteItem] = useState<WorkspaceFileTreeItem | null>(
    null,
  )
  const [jobError, setJobError] = useState<string | null>(null)
  const fileEditorRef = useRef<FileEditorHandle | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSavePathRef = useRef<string | null>(null)
  const latestDraftRef = useRef<{ path: string; body: string } | null>(null)
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const writableRef = useRef(writable)
  writableRef.current = writable
  const [editorHistory, setEditorHistory] = useState<FileEditorHistory>({
    canUndo: false,
    canRedo: false,
  })
  const [historyFile, setHistoryFile] = useState(props.activeFile)
  if (historyFile !== props.activeFile) {
    setHistoryFile(props.activeFile)
    setEditorHistory({ canUndo: false, canRedo: false })
  }
  const fileName = props.activeFile
    ? (props.activeFile.split("/").pop() ?? props.activeFile)
    : null
  const activeDraft = props.activeFile ? drafts[props.activeFile] : undefined
  const dirty = activeDraft !== undefined
  const gitStatus = useMemo(() => {
    const byPath = new Map(
      props.gitStatus.map((item) => [item.path, item] as const),
    )
    for (const path of Object.keys(drafts)) {
      const existing = byPath.get(path)
      byPath.set(path, {
        path,
        status: existing?.status ?? "modified",
        body: drafts[path],
        additions: existing?.additions,
        deletions: existing?.deletions,
      })
    }
    return [...byPath.values()]
  }, [drafts, props.gitStatus])

  const invalidateFiles = async () => {
    if (props.conversationId) {
      await queryClient.invalidateQueries({
        queryKey: workspaceKeys.conversationGitTree(
          props.orgSlug,
          props.conversationId,
        ),
      })
      await queryClient.invalidateQueries({
        queryKey: workspaceKeys.conversationGitStatus(
          props.orgSlug,
          props.conversationId,
        ),
      })
      await queryClient.invalidateQueries({
        queryKey: workspaceKeys.conversationGitDiff(
          props.orgSlug,
          props.conversationId,
        ),
      })
      await queryClient.invalidateQueries({
        queryKey: [
          "conversation-git-blob",
          props.orgSlug,
          props.conversationId,
        ],
      })
      return
    }
    await queryClient.invalidateQueries({
      queryKey: workspaceKeys.gitTree(
        props.orgSlug,
        props.workspaceSlug,
        props.sha,
      ),
    })
    await queryClient.invalidateQueries({
      queryKey: workspaceKeys.gitStatus(
        props.orgSlug,
        props.workspaceSlug,
        props.sha,
      ),
    })
    await queryClient.invalidateQueries({
      queryKey: [
        "workspace-git-blob",
        props.orgSlug,
        props.workspaceSlug,
        props.sha,
      ],
    })
  }

  const jobMutation = useMutation({
    mutationFn: (input: WorkspaceFileJobRequest) => {
      if (!props.conversationId) {
        throw new Error("Conversation sandbox is not ready")
      }
      return persistConversationFileMutation(
        props.orgSlug,
        props.conversationId,
        input,
      )
    },
    onMutate: async (input) => {
      setJobError(null)
      const key = props.conversationId
        ? workspaceKeys.conversationGitTree(props.orgSlug, props.conversationId)
        : workspaceKeys.gitTree(props.orgSlug, props.workspaceSlug, props.sha)
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<WorkspaceGitTreeResponse>(key)
      if (!previous || input.op === "save") return { previous }
      const nextPaths =
        input.op === "create"
          ? optimisticPathsAfterJob(previous.paths, {
              op: "create",
              path:
                input.kind === "folder" ? `${input.path}/.gitkeep` : input.path,
            })
          : input.op === "delete"
            ? optimisticPathsAfterJob(previous.paths, {
                op: "delete",
                path: input.path,
              })
            : input.op === "rename"
              ? optimisticPathsAfterJob(previous.paths, {
                  op: "rename",
                  from: input.from,
                  to: input.to,
                })
              : optimisticPathsAfterJob(previous.paths, {
                  op: "move",
                  from: input.from,
                  toDirectory: input.toDirectory,
                })
      queryClient.setQueryData(key, { ...previous, paths: nextPaths })
      return { previous }
    },
    onSuccess: async (_data, input) => {
      setJobError(null)
      if (input.op === "save") {
        setDrafts((current) => {
          if (current[input.path] !== input.content) return current
          const next = { ...current }
          delete next[input.path]
          return next
        })
        if (
          latestDraftRef.current?.path === input.path &&
          latestDraftRef.current.body === input.content
        ) {
          latestDraftRef.current = null
        }
      }
      if (input.op === "rename") props.onPinFile(input.to)
      if (input.op === "move") {
        const name = input.from.split("/").pop() ?? input.from
        const next = input.toDirectory ? `${input.toDirectory}/${name}` : name
        props.onPinFile(next)
      }
      if (input.op === "create" && input.kind === "file") {
        props.onPinFile(input.path)
      }
      if (input.op === "delete" && props.activeFile) {
        const prefix = `${input.path}/`
        if (
          props.activeFile === input.path ||
          props.activeFile.startsWith(prefix)
        ) {
          props.onCloseActiveFile()
        }
      }
      await invalidateFiles()
    },
    onError: (error, _input, context) => {
      setJobError(
        error instanceof Error ? error.message : "Failed to save file changes",
      )
      if (context?.previous) {
        queryClient.setQueryData(
          props.conversationId
            ? workspaceKeys.conversationGitTree(
                props.orgSlug,
                props.conversationId,
              )
            : workspaceKeys.gitTree(
                props.orgSlug,
                props.workspaceSlug,
                props.sha,
              ),
          context.previous,
        )
      }
    },
  })

  const flushSave = useCallback(
    (path: string | null) => {
      if (!writableRef.current || !path) return
      const latest = latestDraftRef.current
      const content =
        latest?.path === path ? latest.body : draftsRef.current[path]
      if (content === undefined) return
      jobMutation.mutate({ op: "save", path, content })
    },
    [jobMutation],
  )

  const clearAutosaveTimer = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
  }, [])

  const scheduleAutosave = (path: string) => {
    if (!writableRef.current) return
    if (pendingSavePathRef.current && pendingSavePathRef.current !== path) {
      const previous = pendingSavePathRef.current
      clearAutosaveTimer()
      pendingSavePathRef.current = null
      flushSave(previous)
    } else {
      clearAutosaveTimer()
    }
    pendingSavePathRef.current = path
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      const toSave = pendingSavePathRef.current
      pendingSavePathRef.current = null
      flushSave(toSave)
    }, 10_000)
  }

  const saveOnBlur = () => {
    const path = pendingSavePathRef.current ?? props.activeFile
    clearAutosaveTimer()
    pendingSavePathRef.current = null
    flushSave(path)
  }

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!writable) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "s"
      ) {
        return
      }
      event.preventDefault()
      const path = pendingSavePathRef.current ?? props.activeFile
      clearAutosaveTimer()
      pendingSavePathRef.current = null
      flushSave(path)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [props.activeFile, writable, clearAutosaveTimer, flushSave])

  const submitCreate = () => {
    if (!createDialog) return
    const path = joinFileName(createDialog.parentPath, createName)
    if (!path) return
    jobMutation.mutate({
      op: "create",
      path,
      kind: createDialog.kind,
    })
    setCreateDialog(null)
    setCreateName("")
  }

  return (
    <div
      className="relative grid h-full min-h-0 min-w-0 flex-1 overflow-hidden"
      style={{
        gridTemplateColumns: props.treeCollapsed
          ? "minmax(0,1fr)"
          : `minmax(0, ${treeWidth}px) minmax(0,1fr)`,
        gridTemplateRows: "minmax(0,1fr)",
      }}
    >
      {props.treeCollapsed ? null : (
        <div className="relative flex h-full min-h-0 min-w-0 flex-col border-r border-white/[0.06]">
          <WorkspaceFileTree
            paths={props.tree.paths}
            selectedPath={props.activeFile}
            gitStatus={gitStatus}
            writable={writable}
            onHoverFile={prefetchBlob}
            onSelect={(path) => {
              prefetchBlob(path)
              props.onPreviewFile(path)
            }}
            onPin={props.onPinFile}
            onHideTree={props.onToggleTree}
            onRequestCreate={(kind, parentPath) => {
              setCreateName("")
              setCreateDialog({ kind, parentPath })
            }}
            onRequestDelete={setDeleteItem}
            onRename={(from, to) =>
              jobMutation.mutate({ op: "rename", from, to })
            }
            onMove={(from, toDirectory) =>
              jobMutation.mutate({ op: "move", from, toDirectory })
            }
          />
          <button
            type="button"
            role="slider"
            aria-label="Resize file tree"
            aria-orientation="vertical"
            aria-valuemin={TREE_WIDTH_MIN}
            aria-valuemax={TREE_WIDTH_MAX}
            aria-valuenow={treeWidth}
            className={cn(
              "absolute inset-y-0 right-0 z-20 w-3 translate-x-1/2 cursor-col-resize border-0 bg-transparent p-0 outline-0",
              "after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2",
              "after:bg-transparent after:transition-colors",
              "hover:after:bg-white/40 focus-visible:after:bg-white/40",
              treeResizing && "after:bg-white/40",
            )}
            onPointerDown={(event) => {
              event.preventDefault()
              const target = event.currentTarget
              target.setPointerCapture(event.pointerId)
              const startX = event.clientX
              const startWidth = treeWidth
              setTreeResizing(true)
              document.body.style.cursor = "col-resize"
              document.body.style.userSelect = "none"
              const move = (next: PointerEvent) => {
                setTreeWidth(
                  clampTreeWidth(startWidth + (next.clientX - startX)),
                )
              }
              const up = (next: PointerEvent) => {
                target.releasePointerCapture(next.pointerId)
                window.removeEventListener("pointermove", move)
                window.removeEventListener("pointerup", up)
                document.body.style.cursor = ""
                document.body.style.userSelect = ""
                setTreeResizing(false)
              }
              window.addEventListener("pointermove", move)
              window.addEventListener("pointerup", up)
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                return
              }
              event.preventDefault()
              const step = event.shiftKey ? 24 : 8
              const delta = event.key === "ArrowRight" ? step : -step
              setTreeWidth((width) => clampTreeWidth(width + delta))
            }}
          />
        </div>
      )}
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <div
          className={cn(
            "flex h-8 shrink-0 items-center gap-1 pr-1",
            props.treeCollapsed ? "pl-1" : "pl-3",
          )}
        >
          {props.treeCollapsed ? (
            <Button
              variant="quiet"
              size="icon-sm"
              aria-label="Show tree"
              onPress={props.onToggleTree}
              className={FILES_HEADER_ICON_BUTTON_CLASS}
            >
              <IconLayoutSidebarLeftExpand
                className="size-4"
                stroke={1.6}
                aria-hidden
              />
            </Button>
          ) : null}
          {fileName ? (
            <span
              className="min-w-0 flex-1 truncate text-sm"
              title={props.activeFile ?? undefined}
            >
              {fileName}
              {dirty ? (
                <span className="ml-1 text-muted-foreground">•</span>
              ) : null}
            </span>
          ) : (
            <span className="min-w-0 flex-1" />
          )}
          {writable && props.activeFile ? (
            <>
              <Button
                variant="quiet"
                size="icon-sm"
                aria-label="Save"
                isDisabled={!dirty || jobMutation.isPending}
                preventFocusOnPress
                onPress={() => {
                  const path = pendingSavePathRef.current ?? props.activeFile
                  clearAutosaveTimer()
                  pendingSavePathRef.current = null
                  flushSave(path)
                }}
                className={FILES_HEADER_ICON_BUTTON_CLASS}
              >
                <IconDeviceFloppy className="size-4" stroke={1.6} aria-hidden />
              </Button>
              <Button
                variant="quiet"
                size="icon-sm"
                aria-label="Undo"
                isDisabled={!editorHistory.canUndo}
                preventFocusOnPress
                onPress={() => fileEditorRef.current?.undo()}
                className={FILES_HEADER_ICON_BUTTON_CLASS}
              >
                <IconArrowBackUp className="size-4" stroke={1.6} aria-hidden />
              </Button>
              <Button
                variant="quiet"
                size="icon-sm"
                aria-label="Redo"
                isDisabled={!editorHistory.canRedo}
                preventFocusOnPress
                onPress={() => fileEditorRef.current?.redo()}
                className={FILES_HEADER_ICON_BUTTON_CLASS}
              >
                <IconArrowForwardUp
                  className="size-4"
                  stroke={1.6}
                  aria-hidden
                />
              </Button>
            </>
          ) : null}
        </div>
        {jobError ? (
          <div className="px-2 pb-2">
            <InlineAlert variant="error" title="Could not save">
              {jobError}
            </InlineAlert>
          </div>
        ) : null}
        {props.activeFile ? (
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <Suspense fallback={<WorkspaceFilePreviewSkeleton />}>
              <WorkspaceGitFilePreview
                orgSlug={props.orgSlug}
                workspaceSlug={props.workspaceSlug}
                conversationId={props.conversationId}
                path={props.activeFile}
                sha={props.sha || props.tree.sha}
                remoteBody={
                  gitStatus.find((item) => item.path === props.activeFile)?.body
                }
                editable={writable}
                editorHandleRef={fileEditorRef}
                onHistoryChange={setEditorHistory}
                onBlur={saveOnBlur}
                onChange={(body, headBody) => {
                  const path = props.activeFile
                  if (!path) return
                  if (body === (headBody ?? "")) {
                    if (latestDraftRef.current?.path === path) {
                      latestDraftRef.current = null
                    }
                    if (pendingSavePathRef.current === path) {
                      clearAutosaveTimer()
                      pendingSavePathRef.current = null
                    }
                    setDrafts((current) => {
                      if (!(path in current)) return current
                      const next = { ...current }
                      delete next[path]
                      return next
                    })
                    return
                  }
                  latestDraftRef.current = { path, body }
                  setDrafts((current) => ({ ...current, [path]: body }))
                  scheduleAutosave(path)
                }}
              />
            </Suspense>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            <p className="text-sm text-muted-foreground">
              Select a file to open it.
            </p>
          </div>
        )}
      </div>
      <Modal
        isOpen={createDialog != null}
        onOpenChange={(open) => {
          if (!open) {
            setCreateDialog(null)
            setCreateName("")
          }
        }}
      >
        <Dialog>
          {({ close }) => (
            <form
              className="p-6"
              onSubmit={(event) => {
                event.preventDefault()
                submitCreate()
                close()
              }}
            >
              <Heading
                slot="title"
                className="my-0 text-lg font-semibold text-zinc-100"
              >
                {createDialog?.kind === "folder" ? "New folder" : "New file"}
              </Heading>
              <TextField
                autoFocus
                label="Name"
                value={createName}
                onChange={setCreateName}
                className="mt-4"
              />
              <div className="mt-6 flex justify-end gap-2">
                <Button variant="ghost" onPress={close}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  isDisabled={
                    !joinFileName(createDialog?.parentPath ?? null, createName)
                  }
                >
                  Create
                </Button>
              </div>
            </form>
          )}
        </Dialog>
      </Modal>
      <Modal
        isOpen={deleteItem != null}
        onOpenChange={(open) => {
          if (!open) setDeleteItem(null)
        }}
      >
        <Dialog role="alertdialog">
          {({ close }) => (
            <div className="p-6">
              <Heading
                slot="title"
                className="my-0 text-lg font-semibold text-zinc-100"
              >
                Delete {deleteItem?.kind === "directory" ? "folder" : "file"}?
              </Heading>
              <div className="absolute right-6 top-6 size-6 text-destructive">
                <IconAlertCircle aria-hidden className="size-6 stroke-2" />
              </div>
              <p className="mt-3 text-sm text-zinc-400">
                This removes{" "}
                <code className="font-mono text-xs text-zinc-200">
                  {deleteItem?.path}
                </code>{" "}
                from the conversation sandbox. Commit+Push publishes it.
              </p>
              <div className="mt-6 flex justify-end gap-2">
                <Button variant="ghost" onPress={close}>
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  onPress={() => {
                    if (deleteItem) {
                      jobMutation.mutate({
                        op: "delete",
                        path: deleteItem.path,
                      })
                    }
                    close()
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          )}
        </Dialog>
      </Modal>
    </div>
  )
}

function WorkspaceGitFilePreview(props: {
  orgSlug: string
  workspaceSlug: string
  conversationId?: string
  path: string
  sha: string
  remoteBody?: string | null
  editable: boolean
  editorHandleRef: { current: FileEditorHandle | null }
  onHistoryChange: (history: FileEditorHistory) => void
  onBlur: () => void
  onChange: (body: string, headBody: string | null) => void
}) {
  if (props.conversationId) {
    return (
      <SandboxGitFilePreview {...props} conversationId={props.conversationId} />
    )
  }
  return <CodesearchGitFilePreview {...props} />
}

function SandboxGitFilePreview(
  props: Omit<Parameters<typeof GitFilePreviewBody>[0], "data"> & {
    conversationId: string
  },
) {
  const { data } = useSuspenseQuery(
    conversationGitBlobOptions(props.orgSlug, props.conversationId, props.path),
  )
  return <GitFilePreviewBody {...props} data={data} />
}

function CodesearchGitFilePreview(
  props: Omit<Parameters<typeof GitFilePreviewBody>[0], "data">,
) {
  const { data } = useSuspenseQuery(
    workspaceGitBlobOptions(
      props.orgSlug,
      props.workspaceSlug,
      props.sha,
      props.path,
    ),
  )
  return <GitFilePreviewBody {...props} data={data} />
}

function GitFilePreviewBody(props: {
  orgSlug: string
  workspaceSlug: string
  conversationId?: string
  path: string
  sha: string
  remoteBody?: string | null
  editable: boolean
  editorHandleRef: { current: FileEditorHandle | null }
  onHistoryChange: (history: FileEditorHistory) => void
  onBlur: () => void
  onChange: (body: string, headBody: string | null) => void
  data: { path: string; body: string | null; binary: boolean }
}) {
  const { data } = props
  const [seenBody, setSeenBody] = useState(data.body)
  const [loadedBody, setLoadedBody] = useState(data.body)
  const [agentUpdated, setAgentUpdated] = useState(false)
  const dirtyVsLoaded =
    props.remoteBody != null && props.remoteBody !== (loadedBody ?? "")
  if (data.body !== seenBody) {
    setSeenBody(data.body)
    if (dirtyVsLoaded && data.body !== loadedBody) {
      setAgentUpdated(true)
    } else if (!dirtyVsLoaded) {
      setLoadedBody(data.body)
      setAgentUpdated(false)
    }
  }
  if (data.binary) {
    return (
      <div className="flex h-full min-h-0 items-center p-4">
        <p className="text-sm text-muted-foreground">
          This file is binary and cannot be previewed.
        </p>
      </div>
    )
  }
  const headBody = agentUpdated ? loadedBody : data.body
  const workingBody = props.remoteBody ?? headBody
  if (workingBody == null && headBody == null) {
    return (
      <div className="p-4">
        <InlineAlert variant="error" title="File not found">
          This path is not in the current git tree.
        </InlineAlert>
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {agentUpdated ? (
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <p className="text-xs text-amber-200">Agent updated this file.</p>
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs"
            onPress={() => {
              setLoadedBody(data.body)
              setAgentUpdated(false)
              props.onChange(data.body ?? "", data.body)
            }}
          >
            Reload
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 min-w-0 flex-1">
        <WorkspacePierreFile
          path={props.path}
          body={workingBody ?? ""}
          oldBody={headBody}
          cacheKey={`${props.conversationId ?? props.sha}:${props.path}:${agentUpdated ? "held" : "live"}`}
          editable={props.editable}
          editorHandleRef={props.editorHandleRef}
          onHistoryChange={props.onHistoryChange}
          onBlur={props.onBlur}
          onChange={(body) => props.onChange(body, headBody)}
        />
      </div>
    </div>
  )
}

function WorkspaceGraphPaneBody(props: {
  orgSlug: string
  workspaceSlug: string
  onOpenSource?: (path: string) => void
}) {
  const { data } = useSuspenseQuery(
    workspaceGraphOptions(props.orgSlug, props.workspaceSlug),
  )
  return (
    <WorkspaceGraphPane
      orgSlug={props.orgSlug}
      workspaceSlug={props.workspaceSlug}
      graph={data}
      pending={false}
      onOpenSource={props.onOpenSource}
    />
  )
}

function prefetchWorkspacePane(
  queryClient: QueryClient,
  orgSlug: string,
  workspace: WorkspaceDetail,
  pane: ParsedPane,
  conversationId?: string,
) {
  const sha =
    workspace.activeProjectionSha?.trim() || workspace.desiredSha?.trim() || ""
  if (pane.kind === "files" || pane.kind === "file") {
    if (conversationId) {
      void queryClient.prefetchQuery(
        conversationGitTreeOptions(orgSlug, conversationId),
      )
      if (pane.kind === "file") {
        void queryClient.prefetchQuery(
          conversationGitBlobOptions(orgSlug, conversationId, pane.path),
        )
      }
    }
    void queryClient.prefetchQuery(
      workspaceGitTreeOptions(orgSlug, workspace.slug, sha),
    )
    if (pane.kind === "file") {
      void queryClient.prefetchQuery(
        workspaceGitBlobOptions(orgSlug, workspace.slug, sha, pane.path),
      )
    }
  } else if (pane.kind === "diff" && conversationId) {
    void queryClient.prefetchQuery(
      conversationGitDiffOptions(orgSlug, conversationId),
    )
  } else if (pane.kind === "graph") {
    void queryClient.prefetchQuery(
      workspaceGraphOptions(orgSlug, workspace.slug),
    )
  }
}

function ConversationDiffTab(props: {
  orgSlug: string
  conversationId: string
  workspaceId: string
  onIntent?: () => void
}) {
  const prepareQuery = useQuery({
    ...workspaceChatPrepareOptions(
      props.orgSlug,
      props.conversationId,
      props.workspaceId,
    ),
  })
  const statusQuery = useQuery({
    ...conversationGitStatusOptions(props.orgSlug, props.conversationId),
    enabled: prepareQuery.isSuccess,
  })
  if (!statusQuery.data?.differsFromDefault) return null
  return (
    <PaneIconTab
      id="diff"
      label="Diff"
      icon={<IconGitCompare stroke={1.6} aria-hidden />}
      onIntent={props.onIntent}
    />
  )
}

function WorkspaceConversationDiffPane(props: {
  orgSlug: string
  conversationId: string
  onOpenFile: (path: string) => void
}) {
  const { data } = useSuspenseQuery(
    conversationGitDiffOptions(props.orgSlug, props.conversationId),
  )
  if (data.items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          No changes vs the default branch.
        </p>
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-auto">
      {data.items.map((item) => (
        <ConversationDiffFile
          key={item.path}
          item={item}
          onOpen={() => props.onOpenFile(item.path)}
        />
      ))}
    </div>
  )
}

function ConversationDiffFile(props: {
  item: ConversationGitDiffItem
  onOpen: () => void
}) {
  return (
    <div className="border-b border-white/[0.06]">
      <Button
        variant="ghost"
        onPress={props.onOpen}
        className="h-8 w-full justify-start rounded-none px-3 font-mono text-xs"
      >
        {props.item.path}
      </Button>
      <div className="h-64 min-h-0">
        <WorkspacePierreFile
          path={props.item.path}
          body={props.item.body ?? ""}
          oldBody={props.item.oldBody}
          cacheKey={`diff:${props.item.path}:${props.item.body?.length ?? 0}`}
        />
      </div>
    </div>
  )
}

function PaneIconTab(props: {
  id: string
  label: string
  icon: ReactNode
  onIntent?: () => void
}) {
  return (
    <Tab
      id={props.id}
      aria-label={props.label}
      onHoverStart={props.onIntent}
      className={({ isSelected }) =>
        cn(workspaceChromeIconTabClassName(isSelected), focusVisibleClassName)
      }
    >
      <span
        title={props.label}
        className="inline-flex size-4 items-center justify-center [&_svg]:size-4 [&_svg]:stroke-[1.6]"
      >
        {props.icon}
      </span>
    </Tab>
  )
}

export function WorkspacePaneTriggers(props: {
  orgSlug: string
  workspace: WorkspaceDetail
  onOpen: (pane: ParsedPane) => void
  onExpand?: () => void
}) {
  const queryClient = useQueryClient()
  const prefetch = (pane: ParsedPane) => {
    prefetchWorkspacePane(queryClient, props.orgSlug, props.workspace, pane)
  }
  return (
    <TooltipProvider delay={200}>
      <div className={workspaceChromeTabStripClassName}>
        <HeaderIcon
          label="Files"
          icon={<IconFolder stroke={1.6} aria-hidden />}
          onIntent={() => prefetch({ kind: "files" })}
          onClick={() => {
            prefetch({ kind: "files" })
            props.onOpen({ kind: "files" })
          }}
        />
        <HeaderIcon
          label="Graph"
          icon={<IconAffiliate stroke={1.6} aria-hidden />}
          onIntent={() => prefetch({ kind: "graph" })}
          onClick={() => {
            prefetch({ kind: "graph" })
            props.onOpen({ kind: "graph" })
          }}
        />
        <HeaderIcon
          label="Settings"
          icon={<IconSettings stroke={1.6} aria-hidden />}
          onClick={() => props.onOpen({ kind: "settings" })}
        />
        {props.onExpand ? (
          <HeaderIcon
            label="Show pane"
            icon={<IconLayoutSidebarRightExpand stroke={1.6} aria-hidden />}
            onClick={props.onExpand}
          />
        ) : null}
      </div>
    </TooltipProvider>
  )
}

/** Same idle tab hit as the tools pane (Files / Graph / Settings). */
function HeaderIcon(props: {
  label: string
  icon: ReactNode
  onClick: () => void
  onIntent?: () => void
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={props.label}
        onClick={props.onClick}
        onPointerEnter={props.onIntent}
        className={cn(
          workspaceChromeTabIdleClassName,
          focusVisibleClassName,
          props.className,
        )}
      >
        <span className="inline-flex size-4 items-center justify-center [&_svg]:size-4 [&_svg]:stroke-[1.6]">
          {props.icon}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={6}
        className="border-0 bg-zinc-800 text-zinc-100 shadow-md"
        arrowClassName="bg-zinc-800 fill-zinc-800"
      >
        {props.label}
      </TooltipContent>
    </Tooltip>
  )
}
