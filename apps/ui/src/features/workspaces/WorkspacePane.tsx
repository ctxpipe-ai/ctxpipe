import {
  IconAffiliate,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconFolder,
  IconSettings,
  IconX,
} from "@tabler/icons-react"
import { useSuspenseQuery } from "@tanstack/react-query"
import type { CSSProperties, ReactNode } from "react"
import { Suspense } from "react"
import {
  Tab,
  TabList,
  TabPanel,
  Tabs,
  type Key,
} from "react-aria-components"
import { OverlayNavMenuButton } from "@/components/OverlayNavButton"
import { Button } from "@/components/ui/Button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import { filePaneId, parsePane, serializePane, type ParsedPane } from "./pane"
import { workspaceFilesOptions, workspaceGraphOptions } from "./queries"
import type { WorkspaceDetail, WorkspaceFilesResponse } from "./types"
import {
  workspaceChromeCardPaneClassName,
  workspaceChromeIconTabClassName,
  workspaceChromeOuterClassName,
  workspaceChromeOuterFlushClassName,
  workspaceChromeTabClassName,
  workspaceChromeTabIdleClassName,
  workspaceChromeTabStripClassName,
} from "./workspaceChrome"
import { WorkspaceFileTree } from "./WorkspaceFileTree"
import { WorkspaceGraphPane } from "./WorkspaceGraphPane"
import { WorkspaceSettingsPane } from "./WorkspaceSettingsPane"

export function WorkspacePane(props: {
  orgSlug: string
  workspace: WorkspaceDetail
  pane: ParsedPane
  fileTabs: string[]
  selectedFilePath: string | null
  treeCollapsed: boolean
  maximized: boolean
  width: number
  onPane: (pane: ParsedPane) => void
  onClose: () => void
  onToggleMaximize: () => void
  onRestoreConversation: () => void
  onResize: (width: number) => void
  onSelectFile: (path: string) => void
  onOpenFileTab: (path: string) => void
  onCloseFileTab: (path: string) => void
  onToggleTree: () => void
  conversationTitle: string
}) {
  const activeFile =
    props.pane.kind === "file" ? props.pane.path : props.selectedFilePath
  const showTreeToggle =
    Boolean(activeFile) &&
    (props.pane.kind === "files" || props.pane.kind === "file")
  const filesTabActive = props.pane.kind === "files"
  const selectedKey = serializePane(props.pane)

  const onSelectTab = (key: Key | null) => {
    if (key == null) return
    const next = parsePane(String(key))
    if (next) props.onPane(next)
  }

  return (
    <aside
      className={cn(
        workspaceChromeOuterClassName,
        workspaceChromeOuterFlushClassName,
        "relative pl-0 pr-3",
        props.maximized
          ? "min-w-0 flex-1"
          : "w-[var(--workspace-pane-width)] max-lg:min-w-0 max-lg:w-auto max-lg:flex-1 shrink-0",
      )}
      style={
        props.maximized
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
          className={[
            "absolute inset-y-[16px] left-0 z-10 hidden w-3 -translate-x-1/2 cursor-col-resize border-0 bg-transparent p-0 lg:block",
            "after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2",
            "after:rounded-full after:bg-transparent after:transition-colors",
            "hover:after:bg-white/40 focus-visible:after:bg-white/40",
          ].join(" ")}
          onPointerDown={(event) => {
            event.preventDefault()
            const startX = event.clientX
            const startWidth = props.width
            const move = (next: PointerEvent) => {
              props.onResize(
                Math.min(
                  720,
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
        className="flex min-h-0 flex-1 flex-col"
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
            <TabList className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
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
                    onKeyDown={(event) => {
                      if (
                        event.key !== "Delete" &&
                        event.key !== "Backspace"
                      ) {
                        return
                      }
                      event.preventDefault()
                      props.onCloseFileTab(path)
                    }}
                  >
                    <span className="truncate font-mono">{title}</span>
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
            <div className="mb-px flex shrink-0 items-center gap-0.5 self-end pb-0.5">
              {showTreeToggle ? (
                <Button
                  variant="quiet"
                  onPress={props.onToggleTree}
                  className="h-7 px-2 text-xs"
                >
                  {props.treeCollapsed ? "Show tree" : "Hide tree"}
                </Button>
              ) : null}
              <Button
                variant="quiet"
                size="icon-sm"
                aria-label={
                  props.maximized ? "Show conversation" : "Maximise pane"
                }
                onPress={props.onToggleMaximize}
                className="hidden lg:inline-flex"
              >
                {props.maximized ? (
                  <IconArrowsMinimize className="size-4" aria-hidden />
                ) : (
                  <IconArrowsMaximize className="size-4" aria-hidden />
                )}
              </Button>
              <Button
                variant="quiet"
                size="icon-sm"
                aria-label="Close pane"
                onPress={props.onClose}
              >
                <IconX className="size-4" aria-hidden />
              </Button>
            </div>
          </div>
        </TooltipProvider>

        <TabPanel
          id={selectedKey}
          className={cn(
            workspaceChromeCardPaneClassName,
            filesTabActive && "rounded-tl-none",
            "flex min-h-0 p-0 outline-0",
          )}
        >
          <div className="flex min-h-0 flex-1">
            {props.pane.kind === "files" || props.pane.kind === "file" ? (
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center p-4">
                    <p className="text-xs text-muted-foreground">
                      Loading files…
                    </p>
                  </div>
                }
              >
                <WorkspaceFilesPaneBody
                  orgSlug={props.orgSlug}
                  workspaceSlug={props.workspace.slug}
                  activeFile={activeFile}
                  treeCollapsed={props.treeCollapsed}
                  onSelectFile={props.onSelectFile}
                  onOpenFileTab={props.onOpenFileTab}
                />
              </Suspense>
            ) : null}
            {props.pane.kind === "graph" ? (
              <Suspense
                fallback={
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <div className="h-3 w-24 rounded-lg bg-zinc-800" />
                    <div className="h-8 rounded-lg bg-zinc-900" />
                    <div className="h-8 rounded-lg bg-zinc-900" />
                  </div>
                }
              >
                <WorkspaceGraphPaneBody
                  orgSlug={props.orgSlug}
                  workspaceSlug={props.workspace.slug}
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
  activeFile: string | null
  treeCollapsed: boolean
  onSelectFile: (path: string) => void
  onOpenFileTab: (path: string) => void
}) {
  const { data } = useSuspenseQuery(
    workspaceFilesOptions(props.orgSlug, props.workspaceSlug),
  )
  return (
    <WorkspaceFilesPaneContent
      files={data}
      activeFile={props.activeFile}
      treeCollapsed={props.treeCollapsed}
      onSelectFile={props.onSelectFile}
      onOpenFileTab={props.onOpenFileTab}
    />
  )
}

function WorkspaceFilesPaneContent(props: {
  files: WorkspaceFilesResponse
  activeFile: string | null
  treeCollapsed: boolean
  onSelectFile: (path: string) => void
  onOpenFileTab: (path: string) => void
}) {
  const preview = props.files.items.find(
    (file) => file.path === props.activeFile,
  )
  return (
    <>
      {props.treeCollapsed ? null : (
        <div className="w-52 shrink-0 overflow-auto border-r border-white/[0.06] p-3">
          {props.files.items.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No knowledge files in this projection yet.
            </p>
          ) : (
            <WorkspaceFileTree
              nodes={props.files.tree}
              selectedPath={props.activeFile}
              onSelect={props.onSelectFile}
              onOpenTab={props.onOpenFileTab}
            />
          )}
        </div>
      )}
      <div className="min-w-0 flex-1 overflow-auto p-4">
        {preview ? (
          <article>
            <p className="mb-3 font-mono text-xs text-muted-foreground">
              {preview.path}
            </p>
            <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
              {preview.body}
            </pre>
          </article>
        ) : (
          <p className="text-sm text-muted-foreground">
            Single-click a file to preview. Double-click opens a tab (
            <code className="font-mono text-xs">{filePaneId("path")}</code>
            ).
          </p>
        )}
      </div>
    </>
  )
}

function WorkspaceGraphPaneBody(props: {
  orgSlug: string
  workspaceSlug: string
}) {
  const { data } = useSuspenseQuery(
    workspaceGraphOptions(props.orgSlug, props.workspaceSlug),
  )
  return <WorkspaceGraphPane graph={data} pending={false} />
}

function PaneIconTab(props: {
  id: string
  label: string
  icon: ReactNode
}) {
  return (
    <Tab
      id={props.id}
      aria-label={props.label}
      title={props.label}
      className={({ isSelected }) =>
        cn(
          workspaceChromeIconTabClassName(isSelected),
          focusVisibleClassName,
        )
      }
    >
      <span className="inline-flex size-4 items-center justify-center [&_svg]:size-4 [&_svg]:stroke-[1.6]">
        {props.icon}
      </span>
    </Tab>
  )
}

export function WorkspacePaneTriggers(props: {
  onOpen: (pane: ParsedPane) => void
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
      </div>
    </TooltipProvider>
  )
}

/** Same idle tab hit as the tools pane (Files / Graph / Settings). */
function HeaderIcon(props: {
  label: string
  icon: ReactNode
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={props.label}
        onClick={props.onClick}
        className={cn(workspaceChromeTabIdleClassName, focusVisibleClassName)}
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
