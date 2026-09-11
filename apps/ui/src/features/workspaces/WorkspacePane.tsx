import {
  IconAffiliate,
  IconArrowsDiagonal2,
  IconArrowsDiagonalMinimize,
  IconFolder,
  IconGitCompare,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconSettings,
  IconX,
} from "@tabler/icons-react"
import {
  type QueryClient,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import type { CSSProperties, ReactNode } from "react"
import { Suspense, useEffect, useRef } from "react"
import { type Key, Tab, TabList, TabPanel, Tabs } from "react-aria-components"
import { OverlayNavMenuButton } from "@/components/OverlayNavButton"
import { Button } from "@/components/ui/Button"
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
import { filePaneId, type ParsedPane, parsePane, serializePane } from "./pane"
import {
  conversationGitBlobOptions,
  conversationGitDiffOptions,
  conversationGitStatusOptions,
  conversationGitTreeOptions,
  workspaceChatPrepareOptions,
  workspaceGitBlobOptions,
  workspaceGitTreeOptions,
  workspaceGraphOptions,
} from "./queries"
import type { WorkspaceDetail } from "./types"
import { useConversationPublish } from "./useConversationPublish"
import { ConversationPublishActions } from "./WorkspaceChatChrome"
import { WorkspaceConversationDiffPane } from "./WorkspaceConversationDiff"
import { WorkspaceFilesPaneBody } from "./WorkspaceFilesPane"
import { WorkspaceGraphPane } from "./WorkspaceGraphPane"
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
import { WorkspaceFilesPaneSkeleton } from "./workspaceSkeletons"

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
              {props.conversationId &&
              conversationAllowsEdits(
                props.workspace.writeStatus,
                props.workspace.conversationWritable,
              ) ? (
                <ConversationPanePublish
                  orgSlug={props.orgSlug}
                  workspaceId={props.workspace.id}
                  conversationId={props.conversationId}
                  title={props.conversationTitle}
                />
              ) : null}
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
                  conversationWritable={props.workspace.conversationWritable}
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
    } else {
      void queryClient.prefetchQuery(
        workspaceGitTreeOptions(orgSlug, workspace.slug, sha),
      )
      if (pane.kind === "file") {
        void queryClient.prefetchQuery(
          workspaceGitBlobOptions(orgSlug, workspace.slug, sha, pane.path),
        )
      }
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

function ConversationPanePublish(props: {
  orgSlug: string
  workspaceId: string
  conversationId: string
  title: string
}) {
  const publish = useConversationPublish({
    orgSlug: props.orgSlug,
    conversationId: props.conversationId,
    workspaceId: props.workspaceId,
    title: props.title,
    statusEnabled: true,
    pullEnabled: true,
  })
  return <ConversationPublishActions publish={publish.chrome} />
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
