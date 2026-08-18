import {
  IconAffiliate,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconFolder,
  IconSettings,
  IconX,
} from "@tabler/icons-react"
import { useSuspenseQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { Suspense } from "react"
import { Button } from "@/components/ui/Button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import { filePaneId, type ParsedPane } from "./pane"
import { workspaceFilesOptions, workspaceGraphOptions } from "./queries"
import type { WorkspaceDetail, WorkspaceFilesResponse } from "./types"
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

  return (
    <aside
      className={[
        "relative flex min-h-0 flex-col border-border bg-zinc-950",
        props.maximized ? "min-w-0 flex-1" : "shrink-0 border-l",
      ].join(" ")}
      style={props.maximized ? undefined : { width: props.width }}
    >
      {props.maximized ? null : (
        <button
          type="button"
          aria-label="Resize pane"
          className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-teal-400/40"
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
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        {props.maximized ? (
          <button
            type="button"
            onClick={props.onRestoreConversation}
            className="mr-1 truncate rounded-lg px-2 py-1 text-left text-sm font-medium hover:bg-zinc-900"
          >
            {props.conversationTitle}
          </button>
        ) : null}
        <PaneTabButton
          label="Files"
          active={props.pane.kind === "files"}
          onClick={() => props.onPane({ kind: "files" })}
        />
        <PaneTabButton
          label="Graph"
          active={props.pane.kind === "graph"}
          onClick={() => props.onPane({ kind: "graph" })}
        />
        <PaneTabButton
          label="Settings"
          active={props.pane.kind === "settings"}
          onClick={() => props.onPane({ kind: "settings" })}
        />
        {props.fileTabs.map((path) => {
          const title = path.split("/").pop() ?? path
          const active = props.pane.kind === "file" && props.pane.path === path
          return (
            <span
              key={path}
              className={[
                "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs",
                active
                  ? "bg-zinc-800 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              <button
                type="button"
                onClick={() => props.onPane({ kind: "file", path })}
                className="font-mono"
              >
                {title}
              </button>
              <button
                type="button"
                aria-label={`Close ${title}`}
                onClick={() => props.onCloseFileTab(path)}
                className="rounded p-0.5 hover:bg-zinc-700"
              >
                <IconX className="size-3" aria-hidden />
              </button>
            </span>
          )
        })}
        <div className="flex-1" />
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
          aria-label={props.maximized ? "Show conversation" : "Maximise pane"}
          onPress={props.onToggleMaximize}
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
      <div className="flex min-h-0 flex-1">
        {props.pane.kind === "files" || props.pane.kind === "file" ? (
          <Suspense
            fallback={
              <div className="flex flex-1 items-center p-4">
                <p className="text-xs text-muted-foreground">Loading files…</p>
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
        <div className="w-52 shrink-0 overflow-auto border-r border-border p-3">
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

function PaneTabButton(props: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={[
        "rounded-lg px-2 py-1 text-xs",
        props.active
          ? "bg-zinc-800 text-foreground"
          : "text-muted-foreground hover:text-foreground",
      ].join(" ")}
    >
      {props.label}
    </button>
  )
}

export function WorkspacePaneTriggers(props: {
  onOpen: (pane: ParsedPane) => void
}) {
  return (
    <TooltipProvider delay={200}>
      <div className="mb-0.5 flex items-center gap-0">
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

/** Compact hit target: larger glyph, less padding than a full `size-9` tab. */
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
        className={cn(
          "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-zinc-400",
          "transition-colors hover:bg-teal-900/30 hover:text-zinc-50",
          focusVisibleClassName,
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
