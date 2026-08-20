import {
  IconAffiliate,
  IconAlertCircle,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconArrowsDiagonal2,
  IconArrowsDiagonalMinimize,
  IconFolder,
  IconLayoutSidebarLeftExpand,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconSettings,
  IconX,
} from "@tabler/icons-react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import type { CSSProperties, ReactNode } from "react"
import { Suspense, useEffect, useMemo, useRef, useState } from "react"
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
import { cn } from "@/lib/utils"
import { joinFileName, optimisticPathsAfterJob } from "./fileTreeMutations"
import { filePaneId, type ParsedPane, parsePane, serializePane } from "./pane"
import {
  enqueueWorkspaceFileJob,
  workspaceGitBlobOptions,
  workspaceGitStatusOptions,
  workspaceGitTreeOptions,
  workspaceGraphOptions,
  workspaceKeys,
} from "./queries"
import type {
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

export function WorkspacePane(props: {
  orgSlug: string
  workspace: WorkspaceDetail
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
  const activeFile = props.pane.kind === "file" ? props.pane.path : null
  const filesTabActive = props.pane.kind === "files"
  const selectedKey = serializePane(props.pane)
  const paneWidthLocked = props.width != null

  const onSelectTab = (key: Key | null) => {
    if (key == null) return
    const next = parsePane(String(key))
    if (next) props.onPane(next)
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
              />
              <PaneIconTab
                id="graph"
                label="Graph"
                icon={<IconAffiliate stroke={1.6} aria-hidden />}
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
            {props.pane.kind === "files" || props.pane.kind === "file" ? (
              <Suspense
                fallback={
                  <div className="flex h-full min-h-0 flex-1 items-center p-4">
                    <p className="text-xs text-muted-foreground">
                      Loading files…
                    </p>
                  </div>
                }
              >
                <WorkspaceFilesPaneBody
                  orgSlug={props.orgSlug}
                  workspaceSlug={props.workspace.slug}
                  sha={
                    props.workspace.activeProjectionSha?.trim() ||
                    props.workspace.desiredSha?.trim() ||
                    ""
                  }
                  writeStatus={props.workspace.writeStatus}
                  activeFile={activeFile}
                  treeCollapsed={props.treeCollapsed}
                  onPreviewFile={props.onPreviewFile}
                  onPinFile={props.onPinFile}
                  onToggleTree={props.onToggleTree}
                  onCloseActiveFile={props.onCloseActiveFile}
                />
              </Suspense>
            ) : null}
            {props.pane.kind === "graph" ? (
              <Suspense
                fallback={
                  <WorkspaceGraphPane
                    orgSlug={props.orgSlug}
                    workspaceSlug={props.workspace.slug}
                    graph={undefined}
                    pending
                    onOpenSource={props.onPinFile}
                  />
                }
              >
                <WorkspaceGraphPaneBody
                  orgSlug={props.orgSlug}
                  workspaceSlug={props.workspace.slug}
                  onOpenSource={props.onPinFile}
                />
              </Suspense>
            ) : null}
            {props.pane.kind === "settings" ? (
              <WorkspaceSettingsPane
                orgSlug={props.orgSlug}
                workspace={props.workspace}
              />
            ) : null}
            {props.pane.kind === "unknown" ? (
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
  sha: string
  writeStatus: string
  activeFile: string | null
  treeCollapsed: boolean
  onPreviewFile: (path: string) => void
  onPinFile: (path: string) => void
  onToggleTree: () => void
  onCloseActiveFile: () => void
}) {
  const { data } = useSuspenseQuery(
    workspaceGitTreeOptions(props.orgSlug, props.workspaceSlug, props.sha),
  )
  const statusQuery = useQuery(
    workspaceGitStatusOptions(props.orgSlug, props.workspaceSlug, props.sha),
  )
  return (
    <div className="h-full min-h-0 min-w-0 flex-1">
      <WorkspaceFilesPaneContent
        orgSlug={props.orgSlug}
        workspaceSlug={props.workspaceSlug}
        sha={props.sha}
        writeStatus={props.writeStatus}
        tree={data}
        gitStatus={statusQuery.data?.items ?? []}
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
  sha: string
  writeStatus: string
  tree: WorkspaceGitTreeResponse
  gitStatus: readonly WorkspaceGitStatusItem[]
  activeFile: string | null
  treeCollapsed: boolean
  onPreviewFile: (path: string) => void
  onPinFile: (path: string) => void
  onToggleTree: () => void
  onCloseActiveFile: () => void
}) {
  const queryClient = useQueryClient()
  const writable = props.writeStatus === "writable"
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
    mutationFn: (input: WorkspaceFileJobRequest) =>
      enqueueWorkspaceFileJob(props.orgSlug, props.workspaceSlug, input),
    onMutate: async (input) => {
      setJobError(null)
      const key = workspaceKeys.gitTree(
        props.orgSlug,
        props.workspaceSlug,
        props.sha,
      )
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
          workspaceKeys.gitTree(props.orgSlug, props.workspaceSlug, props.sha),
          context.previous,
        )
      }
    },
  })

  const flushSave = (path: string | null) => {
    if (!writableRef.current || !path) return
    const latest = latestDraftRef.current
    const content =
      latest?.path === path ? latest.body : draftsRef.current[path]
    if (content === undefined) return
    jobMutation.mutate({ op: "save", path, content })
  }

  const clearAutosaveTimer = () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
  }

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
            onSelect={props.onPreviewFile}
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
            <Suspense
              fallback={
                <div className="flex h-full items-center p-4">
                  <p className="text-sm text-muted-foreground">Loading file…</p>
                </div>
              }
            >
              <WorkspaceGitFilePreview
                orgSlug={props.orgSlug}
                workspaceSlug={props.workspaceSlug}
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
                This queues a write job that removes{" "}
                <code className="font-mono text-xs text-zinc-200">
                  {deleteItem?.path}
                </code>{" "}
                from the Workspace repository.
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
  path: string
  sha: string
  remoteBody?: string | null
  editable: boolean
  editorHandleRef: { current: FileEditorHandle | null }
  onHistoryChange: (history: FileEditorHistory) => void
  onBlur: () => void
  onChange: (body: string, headBody: string | null) => void
}) {
  const { data } = useSuspenseQuery(
    workspaceGitBlobOptions(
      props.orgSlug,
      props.workspaceSlug,
      props.sha,
      props.path,
    ),
  )
  if (data.binary) {
    return (
      <div className="flex h-full min-h-0 items-center p-4">
        <p className="text-sm text-muted-foreground">
          This file is binary and cannot be previewed.
        </p>
      </div>
    )
  }
  const headBody = data.body
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
    <div className="h-full min-h-0 min-w-0">
      <WorkspacePierreFile
        path={props.path}
        body={workingBody ?? ""}
        oldBody={headBody}
        cacheKey={`${props.sha}:${props.path}`}
        editable={props.editable}
        editorHandleRef={props.editorHandleRef}
        onHistoryChange={props.onHistoryChange}
        onBlur={props.onBlur}
        onChange={(body) => props.onChange(body, headBody)}
      />
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

function PaneIconTab(props: { id: string; label: string; icon: ReactNode }) {
  return (
    <Tab
      id={props.id}
      aria-label={props.label}
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
  onOpen: (pane: ParsedPane) => void
  onExpand?: () => void
}) {
  return (
    <TooltipProvider delay={200}>
      <div className={workspaceChromeTabStripClassName}>
        <HeaderIcon
          label="Files"
          icon={<IconFolder stroke={1.6} aria-hidden />}
          onClick={() => props.onOpen({ kind: "files" })}
        />
        <HeaderIcon
          label="Graph"
          icon={<IconAffiliate stroke={1.6} aria-hidden />}
          onClick={() => props.onOpen({ kind: "graph" })}
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
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={props.label}
        onClick={props.onClick}
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
