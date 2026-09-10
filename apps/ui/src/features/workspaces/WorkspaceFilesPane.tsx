import {
  IconAlertCircle,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconDeviceFloppy,
  IconLayoutSidebarLeftExpand,
} from "@tabler/icons-react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { useParams } from "@tanstack/react-router"
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Heading } from "react-aria-components"
import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Modal } from "@/components/ui/Modal"
import { TextField } from "@/components/ui/TextField"
import { ApiError } from "@/lib/api-result"
import { cn } from "@/lib/utils"
import { conversationAllowsEdits } from "./conversationPublish"
import { joinFileName, optimisticPathsAfterJob } from "./fileTreeMutations"
import {
  applyConversationFileWriteSnapshot,
  conversationGitBlobOptions,
  conversationGitStatusOptions,
  conversationGitTreeOptions,
  persistConversationFileMutation,
  resolveConversationWorktreeVersion,
  workspaceGitBlobOptions,
  workspaceGitStatusOptions,
  workspaceGitTreeOptions,
  workspaceKeys,
} from "./queries"
import type {
  WorkspaceFileJobRequest,
  WorkspaceGitStatusItem,
  WorkspaceGitTreeResponse,
} from "./types"
import {
  WorkspaceFileTree,
  type WorkspaceFileTreeItem,
} from "./WorkspaceFileTree"
import {
  type FileEditorHandle,
  type FileEditorHistory,
  WorkspacePierreFile,
} from "./WorkspacePierreFile"
import {
  WorkspaceFilePreviewSkeleton,
  WorkspaceFilesPaneSkeleton,
} from "./workspaceSkeletons"

export function WorkspaceFilesPaneBody(props: {
  orgSlug: string
  workspaceSlug: string
  conversationId?: string
  sha: string
  writeStatus: string
  conversationWritable?: boolean
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
        conversationWritable={props.conversationWritable}
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
  conversationWritable?: boolean
  activeFile: string | null
  treeCollapsed: boolean
  onPreviewFile: (path: string) => void
  onPinFile: (path: string) => void
  onToggleTree: () => void
  onCloseActiveFile: () => void
}) {
  const sandboxTreeQuery = useQuery(
    conversationGitTreeOptions(props.orgSlug, props.conversationId),
  )
  const sandboxStatusQuery = useQuery({
    ...conversationGitStatusOptions(props.orgSlug, props.conversationId),
    enabled: sandboxTreeQuery.isSuccess,
  })
  const tree = sandboxTreeQuery.data
  const awaitingFirstList =
    !tree || (tree.ready === false && !tree.paths.length)
  if (awaitingFirstList) {
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
        tree={tree}
        gitStatus={sandboxStatusQuery.data?.items ?? []}
        writable={conversationAllowsEdits(
          props.writeStatus,
          props.conversationWritable,
        )}
        updating={false}
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
  updating?: boolean
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
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: workspaceKeys.conversationGitTree(
            props.orgSlug,
            props.conversationId,
          ),
        }),
        queryClient.invalidateQueries({
          queryKey: workspaceKeys.conversationGitStatus(
            props.orgSlug,
            props.conversationId,
          ),
        }),
        queryClient.invalidateQueries({
          queryKey: workspaceKeys.conversationGitDiff(
            props.orgSlug,
            props.conversationId,
          ),
        }),
        queryClient.invalidateQueries({
          queryKey: [
            "conversation-git-blob",
            props.orgSlug,
            props.conversationId,
          ],
        }),
      ])
      return
    }
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: workspaceKeys.gitTree(
          props.orgSlug,
          props.workspaceSlug,
          props.sha,
        ),
      }),
      queryClient.invalidateQueries({
        queryKey: workspaceKeys.gitStatus(
          props.orgSlug,
          props.workspaceSlug,
          props.sha,
        ),
      }),
      queryClient.invalidateQueries({
        queryKey: [
          "workspace-git-blob",
          props.orgSlug,
          props.workspaceSlug,
          props.sha,
        ],
      }),
    ])
  }

  const jobMutation = useMutation({
    mutationFn: async (input: WorkspaceFileJobRequest) => {
      if (!props.conversationId) {
        throw new Error("Conversation sandbox is not ready")
      }
      const expectedWorktreeVersion = await resolveConversationWorktreeVersion(
        queryClient,
        props.orgSlug,
        props.conversationId,
      )
      return persistConversationFileMutation(
        props.orgSlug,
        props.conversationId,
        input,
        expectedWorktreeVersion,
      )
    },
    onMutate: async (input) => {
      setJobError(null)
      const expectedWorktreeVersion = props.conversationId
        ? await resolveConversationWorktreeVersion(
            queryClient,
            props.orgSlug,
            props.conversationId,
          )
        : undefined
      const key = props.conversationId
        ? workspaceKeys.conversationGitTree(props.orgSlug, props.conversationId)
        : workspaceKeys.gitTree(props.orgSlug, props.workspaceSlug, props.sha)
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<WorkspaceGitTreeResponse>(key)
      if (!previous || input.op === "save") {
        return { previous, expectedWorktreeVersion }
      }
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
      return { previous, expectedWorktreeVersion }
    },
    onSuccess: async (data, input, context) => {
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
      if (props.conversationId && data) {
        applyConversationFileWriteSnapshot(
          queryClient,
          props.orgSlug,
          props.conversationId,
          data,
          context?.expectedWorktreeVersion,
        )
        return
      }
      await invalidateFiles()
    },
    onError: (error, _input, context) => {
      if (
        error instanceof ApiError &&
        error.body.error === "stale_worktree" &&
        props.conversationId
      ) {
        void Promise.all([
          queryClient.invalidateQueries({
            queryKey: workspaceKeys.conversationGitTree(
              props.orgSlug,
              props.conversationId,
            ),
          }),
          queryClient.invalidateQueries({
            queryKey: workspaceKeys.conversationGitStatus(
              props.orgSlug,
              props.conversationId,
            ),
          }),
        ])
      }
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

  const writeQueueRef = useRef(Promise.resolve())
  const persistWithStaleRetry = useCallback(
    async (input: WorkspaceFileJobRequest) => {
      try {
        await jobMutation.mutateAsync(input)
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.body.error === "stale_worktree" &&
          props.conversationId
        ) {
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: workspaceKeys.conversationGitTree(
                props.orgSlug,
                props.conversationId,
              ),
            }),
            queryClient.invalidateQueries({
              queryKey: workspaceKeys.conversationGitStatus(
                props.orgSlug,
                props.conversationId,
              ),
            }),
          ])
          await jobMutation.mutateAsync(input)
          return
        }
        throw error
      }
    },
    [jobMutation, props.conversationId, props.orgSlug, queryClient],
  )
  const enqueueWrite = useCallback(
    (input: WorkspaceFileJobRequest) => {
      const pending = persistWithStaleRetry(input).then(() => undefined)
      writeQueueRef.current = writeQueueRef.current
        .catch(() => undefined)
        .then(() => pending)
      return pending
    },
    [persistWithStaleRetry],
  )

  const flushSave = useCallback(
    (path: string | null) => {
      if (!writableRef.current || !path) return
      const latest = latestDraftRef.current
      const content =
        latest?.path === path ? latest.body : draftsRef.current[path]
      if (content === undefined) return
      void enqueueWrite({ op: "save", path, content })
    },
    [enqueueWrite],
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
      const path = pendingSavePathRef.current ?? latestDraftRef.current?.path
      if (!writableRef.current || !path || !props.conversationId) return
      const content =
        latestDraftRef.current?.path === path
          ? latestDraftRef.current.body
          : draftsRef.current[path]
      if (content === undefined) return
      const conversationId = props.conversationId
      const orgSlug = props.orgSlug
      writeQueueRef.current = writeQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const expectedWorktreeVersion =
            await resolveConversationWorktreeVersion(
              queryClient,
              orgSlug,
              conversationId,
            )
          const snapshot = await persistConversationFileMutation(
            orgSlug,
            conversationId,
            { op: "save", path, content },
            expectedWorktreeVersion,
          )
          applyConversationFileWriteSnapshot(
            queryClient,
            orgSlug,
            conversationId,
            snapshot,
            expectedWorktreeVersion,
          )
        })
        .then(() => undefined)
    }
  }, [props.conversationId, props.orgSlug, queryClient])

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
    void enqueueWrite({
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
            busyLabel={props.updating ? "Updating…" : undefined}
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
              void enqueueWrite({ op: "rename", from, to })
            }
            onMove={(from, toDirectory) =>
              void enqueueWrite({ op: "move", from, toDirectory })
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
                      void enqueueWrite({
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
