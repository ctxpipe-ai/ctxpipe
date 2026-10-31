import {
  IconAffiliate,
  IconArrowsDiagonal2,
  IconArrowsDiagonalMinimize,
  IconFileDiff,
  IconFolder,
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
} from "@tanstack/react-query"
import { ClientOnly } from "@tanstack/react-router"
import type { CSSProperties, ReactNode } from "react"
import { lazy, useEffect, useRef } from "react"
import { type Key, Tab, TabList, TabPanel, Tabs } from "react-aria-components"

import { OverlayNavMenuButton } from "@/components/OverlayNavButton"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { SkeletonSuspense } from "@/components/ui/Skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip"
import { OnboardingHint } from "@/features/hints/OnboardingHint"
import { GraphWaitState } from "@/features/knowledge-graph/GraphWaitState"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { useMarkWorkspaceExplored } from "@/lib/useOrgGuide"
import { useUrgentValue } from "@/lib/useUrgentValue"
import { cn } from "@/lib/utils"

import { conversationAllowsEdits } from "./conversationPublish"
import { filePaneId, type ParsedPane, parsePane, serializePane } from "./pane"
import {
  conversationGitBlobOptions,
  conversationGitDiffOptions,
  conversationGitTreeOptions,
  rebuildWorkspaceGraph,
  workspaceChatPrepareOptions,
  workspaceGitBlobOptions,
  workspaceGitTreeOptions,
  workspaceGraphBuilding,
  workspaceGraphOptions,
  workspaceKeys,
} from "./queries"
import type { WorkspaceDetail, WorkspaceStorePhase } from "./types"
import {
  ConversationCtaActions,
  type ConversationCtaChrome,
} from "./WorkspaceChatChrome"
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
  ConversationDiffEmpty,
  WorkspaceConversationDiffPane,
} from "./WorkspaceConversationDiff"
import { WorkspaceFilesPaneBody } from "./WorkspaceFilesPane"
import { WorkspaceSettingsPane } from "./WorkspaceSettingsPane"
import {
  WorkspaceFilesPaneSkeleton,
  WorkspaceGraphPaneSkeleton,
} from "./workspaceSkeletons"

const WorkspaceGraphPane = lazy(() =>
  import("./WorkspaceGraphPane").then((mod) => ({
    default: mod.WorkspaceGraphPane,
  })),
)

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
  /** Opens the Workspace chat with this prompt in the composer. */
  onFixWithAgent?: (prompt: string) => void
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
  /** The CTA state, shared with the conversation header. */
  cta?: ConversationCtaChrome | null
}) {
  const queryClient = useQueryClient()
  const markExplored = useMarkWorkspaceExplored(props.orgSlug)
  const urlPaneKey = serializePane(props.pane)
  const [pane, setPane] = useUrgentValue(props.pane, urlPaneKey)
  const activeFile = pane.kind === "file" ? pane.path : null
  // Every Diff pane variant (one turn, one focused file) is the Diff tab.
  const selectedKey = pane.kind === "diff" ? "diff" : serializePane(pane)
  const paneWidthLocked = props.width != null
  // The cache says if the sandbox is ready. This query never fetches.
  const prepared = useQuery({
    ...workspaceChatPrepareOptions(
      props.orgSlug,
      props.conversationId ?? "",
      props.workspace.id,
    ),
    enabled: false,
  }).isSuccess
  const toolTabs = usePaneToolTabs({
    orgSlug: props.orgSlug,
    workspace: props.workspace,
    conversationId: props.conversationId,
  })
  // The card joins the active tab with a square corner only when that tab
  // leads the strip. Each other tab keeps the round corner.
  const leadTabSelected = selectedKey === toolTabs[0]?.id

  const prefetchPane = (next: ParsedPane) => {
    prefetchWorkspacePane(
      queryClient,
      props.orgSlug,
      props.workspace,
      next,
      props.conversationId,
    )
  }

  /** Open a file as a pinned tab in Files. */
  const openFile = (path: string) => {
    setPane({ kind: "file", path })
    props.onPinFile(path)
  }

  const selectPane = (next: ParsedPane) => {
    markExplored()
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the deps list is kept as is
  }, [props.fileTabs, props.onCloseFileTab])

  return (
    <aside
      className={cn(
        workspaceChromeOuterClassName,
        workspaceChromeOuterFlushClassName,
        "relative flex h-full min-h-0 pl-0 pr-3",
        paneWidthLocked
          ? cn(
              "w-[var(--workspace-pane-width)] shrink-0",
              "max-lg:min-w-0 max-lg:w-auto max-lg:flex-1",
              // Maximize keeps the locked width as the flex basis and grows into the collapsed chat column.
              props.maximized && "min-w-0 grow",
            )
          : "min-w-0 flex-1",
      )}
      style={
        paneWidthLocked
          ? ({
              "--workspace-pane-width": `${props.width}px`,
            } as CSSProperties)
          : undefined
      }
      data-workspace-surface=""
    >
      {props.maximized ? null : (
        <button
          type="button"
          aria-label="Resize pane"
          className={cn(
            "absolute bottom-[20px] left-[0.5px] z-20 hidden w-3 -translate-x-1/2 cursor-col-resize border-0 bg-transparent p-0 lg:block",
            leadTabSelected ? "top-[16px]" : "top-[calc(16px+37px)]",
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
                // Maximize hides the conversation. Its title slides in here, so the user sees where it went.
                "animate-in fade-in slide-in-from-left-1 duration-100 ease-out",
                props.maximized ? "flex" : "hidden max-lg:flex",
              )}
            >
              <span className="truncate">{props.conversationTitle}</span>
            </Button>
            <TabList
              ref={fileTabListRef}
              className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
            >
              {toolTabs.map((tab) => (
                <PaneIconTab
                  key={tab.id}
                  id={tab.id}
                  label={tab.label}
                  icon={tab.icon}
                  busy={tab.busy}
                  onIntent={() => prefetchPane(tab.pane)}
                />
              ))}
              {props.fileTabs.map((path) => {
                const title = path.split("/").pop() ?? path
                const id = filePaneId(path)
                return (
                  <Tab
                    key={id}
                    id={id}
                    ref={selectedKey === id ? scrollTabIntoView : undefined}
                    aria-label={title}
                    className={({ isSelected }) =>
                      cn(
                        "max-w-[12rem] gap-1",
                        newTabClassName,
                        isSelected
                          ? workspaceChromeTabClassName
                          : workspaceChromeTabIdleClassName,
                        focusVisibleClassName,
                        "px-3",
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
                      className="rounded-md p-0.5 hover:bg-zinc-700"
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
            <div className="flex shrink-0 items-end gap-1">
              {/* The conversation header has the CTA actions. The pane
                  shows them only when the conversation column is hidden: below
                  `lg` with the pane open, or when the pane is maximized. */}
              {props.cta &&
              conversationAllowsEdits(
                props.workspace.writeStatus,
                props.workspace.conversationWritable,
              ) ? (
                <ConversationCtaActions
                  cta={props.cta}
                  className={props.maximized ? undefined : "lg:hidden"}
                />
              ) : null}
              <HeaderIcon
                label={props.maximized ? "Show conversation" : "Maximize pane"}
                icon={
                  <span className="relative size-4">
                    <IconArrowsDiagonal2
                      className={cn(
                        "absolute inset-0 transition-[opacity,scale] duration-100 ease-out",
                        props.maximized
                          ? "scale-75 opacity-0"
                          : "scale-100 opacity-100",
                      )}
                      stroke={1.6}
                      aria-hidden
                    />
                    <IconArrowsDiagonalMinimize
                      className={cn(
                        "absolute inset-0 transition-[opacity,scale] duration-100 ease-out",
                        props.maximized
                          ? "scale-100 opacity-100"
                          : "scale-75 opacity-0",
                      )}
                      stroke={1.6}
                      aria-hidden
                    />
                  </span>
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
            // Maximized / max-lg put the conversation title in the lead slot.
            leadTabSelected && !props.maximized && "lg:rounded-tl-none",
            "flex min-h-0 p-0 outline-0",
          )}
        >
          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
            {pane.kind === "files" || pane.kind === "file" ? (
              <SkeletonSuspense
                chain="files"
                fallback={<WorkspaceFilesPaneSkeleton />}
              >
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
                  sandboxPrepared={prepared}
                  activeFile={activeFile}
                  treeCollapsed={props.treeCollapsed}
                  onPreviewFile={(path) => {
                    setPane({ kind: "file", path })
                    props.onPreviewFile(path)
                  }}
                  onPinFile={openFile}
                  onToggleTree={props.onToggleTree}
                  onCloseActiveFile={props.onCloseActiveFile}
                />
              </SkeletonSuspense>
            ) : null}
            {pane.kind === "diff" && props.conversationId && !prepared ? (
              <ConversationDiffEmpty base={null} />
            ) : null}
            {pane.kind === "diff" && props.conversationId && prepared ? (
              <SkeletonSuspense
                chain="files"
                fallback={<WorkspaceFilesPaneSkeleton />}
              >
                <WorkspaceConversationDiffPane
                  orgSlug={props.orgSlug}
                  conversationId={props.conversationId}
                  turn={pane.turn}
                  focusPath={pane.path}
                  onShowAll={() => selectPane({ kind: "diff" })}
                />
              </SkeletonSuspense>
            ) : null}
            {pane.kind === "graph" ? (
              <ClientOnly fallback={<WorkspaceGraphPaneSkeleton />}>
                <WorkspaceGraphPaneBody
                  orgSlug={props.orgSlug}
                  workspace={props.workspace}
                  onOpenSource={openFile}
                />
              </ClientOnly>
            ) : null}
            {pane.kind === "settings" ? (
              <WorkspaceSettingsPane
                orgSlug={props.orgSlug}
                workspace={props.workspace}
                onOpenFile={openFile}
                {...(props.onFixWithAgent
                  ? { onFixWithAgent: props.onFixWithAgent }
                  : {})}
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
  workspace: WorkspaceDetail
  onOpenSource?: (path: string) => void
}) {
  // A detail seeded from the list has no phases; then the graph route decides.
  const phase = props.workspace.hydratePhases?.graph.kind
  const query = useQuery({
    ...workspaceGraphOptions(props.orgSlug, props.workspace.slug),
    enabled: graphReadable(phase),
  })
  const queryClient = useQueryClient()
  // The server can refuse the rebuild, for example a second one in the same
  // UTC hour. The alert then shows its reason. Both answers read the
  // Workspace again to show its phase.
  const rebuild = useMutation({
    mutationFn: () =>
      rebuildWorkspaceGraph(props.orgSlug, props.workspace.slug),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(props.orgSlug, props.workspace.slug),
      }),
  })
  if (phase === "pending" || workspaceGraphBuilding(query.data))
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center p-6">
        <GraphWaitState
          title="Building graph"
          detail="The graph opens when ctxpipe finishes reading this Workspace."
          status="Building graph"
        />
      </div>
    )
  // The failure message can name internal hosts, so the UI shows plain copy.
  if (phase === "failed")
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md">
          <InlineAlert
            variant="error"
            title="Could not build graph"
            actions={
              <Button
                variant="primary"
                isPending={rebuild.isPending}
                onPress={() => rebuild.mutate()}
              >
                Try again
              </Button>
            }
          >
            Could not build the graph. It builds again automatically, or you can
            try again now.
            {rebuild.error ? <> {rebuild.error.message}</> : null}
          </InlineAlert>
        </div>
      </div>
    )
  return (
    <SkeletonSuspense fallback={<WorkspaceGraphPaneSkeleton />}>
      <WorkspaceGraphPane
        orgSlug={props.orgSlug}
        workspaceSlug={props.workspace.slug}
        graph={workspaceGraphBuilding(query.data) ? undefined : query.data}
        pending={query.isPending}
        error={query.error instanceof Error ? query.error : null}
        onOpenSource={props.onOpenSource}
      />
    </SkeletonSuspense>
  )
}

function graphReadable(phase: WorkspaceStorePhase["kind"] | undefined) {
  return phase !== "pending" && phase !== "failed"
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
  } else if (
    pane.kind === "diff" &&
    conversationId &&
    // Before the sandbox is ready the diff request waits on the chat lock.
    queryClient.getQueryState(
      workspaceChatPrepareOptions(orgSlug, conversationId, workspace.id)
        .queryKey,
    )?.status === "success"
  ) {
    void queryClient.prefetchQuery(
      conversationGitDiffOptions(orgSlug, conversationId, pane.turn),
    )
  } else if (
    pane.kind === "graph" &&
    graphReadable(workspace.hydratePhases?.graph.kind)
  ) {
    void queryClient.prefetchQuery(
      workspaceGraphOptions(orgSlug, workspace.slug),
    )
  }
}

type PaneToolTab = {
  id: "files" | "diff" | "graph" | "settings"
  label: string
  icon: ReactNode
  busy?: boolean
  pane: ParsedPane
}

/**
 * The tool tabs in strip order. The pane strip and the closed-pane triggers
 * both show this list, so a new tab shows in both places.
 */
function usePaneToolTabs(props: {
  orgSlug: string
  workspace: WorkspaceDetail
  conversationId?: string
}): PaneToolTab[] {
  const showDiff = Boolean(props.conversationId)
  const graphBuilding = props.workspace.hydratePhases?.graph.kind === "pending"
  const tabs: PaneToolTab[] = [
    {
      id: "files",
      label: "Files",
      icon: <IconFolder stroke={1.6} aria-hidden />,
      pane: { kind: "files" },
    },
    {
      id: "graph",
      label: graphBuilding ? "Graph, building" : "Graph",
      icon: <IconAffiliate stroke={1.6} aria-hidden />,
      busy: graphBuilding,
      pane: { kind: "graph" },
    },
    {
      id: "settings",
      label: "Settings",
      icon: <IconSettings stroke={1.6} aria-hidden />,
      pane: { kind: "settings" },
    },
  ]
  if (showDiff)
    tabs.splice(1, 0, {
      id: "diff",
      label: "Diff",
      icon: <IconFileDiff stroke={1.6} aria-hidden />,
      pane: { kind: "diff" },
    })
  return tabs
}

/**
 * A tab fades in when it mounts: all tabs when the pane opens, and one tab
 * when it joins the strip (Diff, a pinned file). The class stays when the tab
 * is selected, so the fade does not run again.
 */
const newTabClassName = "animate-in fade-in duration-100 ease-out"

/** The selected file tab gets this ref, so a new tab scrolls into the strip. */
function scrollTabIntoView(node: HTMLDivElement | null) {
  node?.scrollIntoView({ block: "nearest", inline: "nearest" })
}

function PaneIconTab(props: {
  id: string
  label: string
  icon: ReactNode
  onIntent?: () => void
  busy?: boolean
}) {
  return (
    <Tab
      id={props.id}
      aria-label={props.label}
      onHoverStart={props.onIntent}
      className={({ isSelected }) =>
        cn(
          workspaceChromeIconTabClassName(isSelected),
          newTabClassName,
          focusVisibleClassName,
        )
      }
    >
      <PaneIcon title={props.label} icon={props.icon} busy={props.busy} />
    </Tab>
  )
}

/** Shows a pulse dot on the icon while the work behind it runs. */
function PaneIcon(props: { icon: ReactNode; busy?: boolean; title?: string }) {
  return (
    <span
      title={props.title}
      className="relative inline-flex size-4 items-center justify-center [&_svg]:size-4 [&_svg]:stroke-[1.6]"
    >
      {props.icon}
      {props.busy ? (
        <span
          className="ctx-indexing-dot absolute -top-0.5 -right-0.5"
          aria-hidden
        />
      ) : null}
    </span>
  )
}

export function WorkspacePaneTriggers(props: {
  orgSlug: string
  workspace: WorkspaceDetail
  conversationId?: string
  onOpen: (pane: ParsedPane) => void
  onExpand?: () => void
}) {
  const queryClient = useQueryClient()
  const markExplored = useMarkWorkspaceExplored(props.orgSlug)
  const prefetch = (pane: ParsedPane) => {
    prefetchWorkspacePane(
      queryClient,
      props.orgSlug,
      props.workspace,
      pane,
      props.conversationId,
    )
  }
  const toolTabs = usePaneToolTabs({
    orgSlug: props.orgSlug,
    workspace: props.workspace,
    conversationId: props.conversationId,
  })
  const stripRef = useRef<HTMLDivElement>(null)
  return (
    <TooltipProvider delay={200}>
      <OnboardingHint id="panes" orgSlug={props.orgSlug} triggerRef={stripRef}>
        Files is the knowledge repository. Graph shows how its files link.
      </OnboardingHint>
      {/* Hide pane mounts the triggers. They fade in, so the user sees where the pane went. */}
      <div
        ref={stripRef}
        className={cn(
          workspaceChromeTabStripClassName,
          "animate-in fade-in duration-100 ease-out",
        )}
      >
        {toolTabs.map((tab) => (
          <HeaderIcon
            key={tab.id}
            label={tab.label}
            icon={tab.icon}
            busy={tab.busy}
            onIntent={() => prefetch(tab.pane)}
            onClick={() => {
              prefetch(tab.pane)
              markExplored()
              props.onOpen(tab.pane)
            }}
          />
        ))}
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
  busy?: boolean
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
        <PaneIcon icon={props.icon} busy={props.busy} />
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
