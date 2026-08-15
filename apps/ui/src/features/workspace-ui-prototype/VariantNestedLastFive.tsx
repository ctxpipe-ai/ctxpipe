import {
  IconAffiliate,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconChevronDown,
  IconChevronRight,
  IconFiles,
  IconFolder,
  IconHome,
  IconPlug,
  IconPlus,
  IconSearch,
  IconSettings,
  IconX,
} from "@tabler/icons-react"
import type { ReactNode } from "react"
import { Logo } from "@/components/Logo/Logo"
import { Button } from "@/components/ui/Button"
import type { KnowledgeFile, PaneTab, Workspace } from "./mock"
import { KNOWLEDGE_FILES } from "./mock"
import {
  ChatTranscript,
  CreateWorkspacePrompt,
  FilePreview,
  FileTree,
  GraphStub,
  SettingsStub,
} from "./stubs"

export const variantName = "Chosen chrome"

export function VariantNestedLastFive(props: {
  workspaces: Workspace[]
  selectedWorkspaceId: string | null
  selectedConversationId: string | null
  expandedIds: string[]
  visibleCounts: Record<string, number>
  paneTab: PaneTab
  fileTabs: KnowledgeFile[]
  selectedFile: KnowledgeFile | null
  treeCollapsed: boolean
  paneOpen: boolean
  paneMaximized: boolean
  paneWidth: number
  paletteOpen: boolean
  onToggleWorkspace: (id: string) => void
  onSelectConversation: (workspaceId: string, conversationId: string) => void
  onNewConversation: (workspaceId: string) => void
  onAddWorkspace: () => void
  onLoadMore: (workspaceId: string) => void
  onPaneTab: (tab: PaneTab) => void
  onSelectFile: (file: KnowledgeFile) => void
  onOpenFileTab: (file: KnowledgeFile) => void
  onCloseFileTab: (path: string) => void
  onToggleTree: () => void
  onOpenPane: (tab: PaneTab) => void
  onClosePane: () => void
  onToggleMaximize: () => void
  onRestoreConversation: () => void
  onResizePane: (width: number) => void
  onTogglePalette: () => void
}) {
  const selected = props.workspaces.find(
    (workspace) => workspace.id === props.selectedWorkspaceId,
  )
  const conversation = selected?.conversations.find(
    (item) => item.id === props.selectedConversationId,
  )
  const emptyOrg = props.workspaces.length === 0
  const title =
    conversation?.name ??
    selected?.name ??
    (emptyOrg ? "No Workspace" : "Workspace")
  const activeFile =
    props.paneTab.type === "file"
      ? (KNOWLEDGE_FILES.find((file) => file.path === props.paneTab.path) ??
        props.selectedFile)
      : props.selectedFile

  return (
    <div className="relative flex min-h-screen bg-background text-foreground">
      <nav className="flex w-56 shrink-0 flex-col border-r border-border">
        <div className="px-3.5 py-4">
          <Logo aria-hidden className="h-5 w-auto" />
        </div>
        <ul className="space-y-1 text-sm">
          <NavRow icon={<IconHome />} label="Home" />
          <NavRow icon={<IconPlug />} label="Connectors" />
          <NavRow
            icon={<IconSearch />}
            label="Search"
            onClick={props.onTogglePalette}
            trailing={
              <kbd className="ml-auto font-mono text-[10px] text-muted-foreground">
                ⌘K
              </kbd>
            }
          />
        </ul>
        <div className="group/ws mt-6">
          <div className="flex h-10 items-center gap-3 px-5">
            <p className="ctx-label-muted text-zinc-600">Workspaces</p>
            <Button
              variant="quiet"
              size="icon-sm"
              aria-label="Add Workspace"
              onPress={props.onAddWorkspace}
              className="ml-auto opacity-0 group-hover/ws:opacity-100"
            >
              <IconPlus className="size-4" aria-hidden />
            </Button>
          </div>
          <ul>
            {props.workspaces.map((workspace) => {
              const collapsible = props.workspaces.length > 1
              const open =
                !collapsible || props.expandedIds.includes(workspace.id)
              const limit = props.visibleCounts[workspace.id] ?? 5
              const shown = workspace.conversations.slice(0, limit)
              const remaining = workspace.conversations.length - shown.length
              const active = selected?.id === workspace.id
              return (
                <li key={workspace.id}>
                  <div
                    className={[
                      "flex h-10 items-center gap-3 px-5",
                      active
                        ? "bg-zinc-900 text-foreground"
                        : "text-zinc-300 hover:bg-zinc-900",
                    ].join(" ")}
                  >
                    <button
                      type="button"
                      onClick={() => props.onToggleWorkspace(workspace.id)}
                      aria-expanded={collapsible ? open : undefined}
                      className="group/ws-title flex min-w-0 flex-1 items-center gap-3 text-left text-sm"
                    >
                      <WorkspaceGlyph open={open} collapsible={collapsible} />
                      <span className="truncate">{workspace.name}</span>
                    </button>
                    <Button
                      variant="quiet"
                      size="icon-sm"
                      aria-label={`New conversation in ${workspace.name}`}
                      onPress={() => props.onNewConversation(workspace.id)}
                    >
                      <IconPlus className="size-4" aria-hidden />
                    </Button>
                  </div>
                  {open ? (
                    <div className="mb-1 flex gap-3 px-5">
                      <span className="size-5 shrink-0" aria-hidden />
                      <ul className="min-w-0 flex-1 border-l border-border pl-3">
                        {shown.length === 0 ? (
                          <li className="py-1 text-xs text-muted-foreground">
                            No conversations
                          </li>
                        ) : (
                          shown.map((item) => (
                            <li key={item.id}>
                              <button
                                type="button"
                                onClick={() =>
                                  props.onSelectConversation(
                                    workspace.id,
                                    item.id,
                                  )
                                }
                                className={[
                                  "w-full truncate rounded-lg py-1 text-left text-xs",
                                  conversation?.id === item.id
                                    ? "text-foreground"
                                    : "text-muted-foreground hover:text-foreground",
                                ].join(" ")}
                              >
                                {item.name}
                              </button>
                            </li>
                          ))
                        )}
                        {remaining > 0 ? (
                          <li>
                            <Button
                              variant="quiet"
                              onPress={() => props.onLoadMore(workspace.id)}
                              className="h-7 px-0 text-xs"
                            >
                              Load more
                            </Button>
                          </li>
                        ) : null}
                      </ul>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>
        <div className="flex-1" />
        <p className="px-4 py-3 text-xs text-muted-foreground">acme · you</p>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1">
        {props.paneMaximized ? null : (
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-12 items-center gap-3 border-b border-border px-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{title}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {selected
                    ? `${selected.repo}${conversation ? ` · ${conversation.lastBranch}` : ""}`
                    : "Create is link — no draft"}
                </p>
              </div>
              {selected?.readonly ? (
                <span
                  title={selected.readonlyReason ?? "Read-only Workspace"}
                  className="shrink-0 rounded-lg border border-amber-500 bg-amber-950 px-2 py-0.5 text-xs font-medium text-amber-200"
                >
                  Read-only
                </span>
              ) : null}
              {props.paneOpen ? null : (
                <div className="flex gap-1">
                  <HeaderIcon
                    label="Files"
                    icon={<IconFiles />}
                    onClick={() => props.onOpenPane({ type: "files" })}
                  />
                  <HeaderIcon
                    label="Graph"
                    icon={<IconAffiliate />}
                    onClick={() => props.onOpenPane({ type: "graph" })}
                  />
                  <HeaderIcon
                    label="Settings"
                    icon={<IconSettings />}
                    onClick={() => props.onOpenPane({ type: "settings" })}
                  />
                </div>
              )}
            </header>
            <section className="min-h-0 min-w-0 flex-1">
              {emptyOrg ? (
                <CreateWorkspacePrompt onCreate={props.onAddWorkspace} />
              ) : (
                <ChatTranscript
                  conversationName={conversation?.name ?? null}
                  empty={!conversation}
                />
              )}
            </section>
          </div>
        )}

        {props.paneOpen ? (
          <aside
            className={[
              "relative flex min-h-0 flex-col border-border bg-zinc-950",
              props.paneMaximized ? "min-w-0 flex-1" : "shrink-0 border-l",
            ].join(" ")}
            style={props.paneMaximized ? undefined : { width: props.paneWidth }}
          >
            {props.paneMaximized ? null : (
              <button
                type="button"
                aria-label="Resize pane"
                className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-teal-400/40"
                onPointerDown={(event) => {
                  event.preventDefault()
                  const startX = event.clientX
                  const startWidth = props.paneWidth
                  const move = (next: PointerEvent) => {
                    props.onResizePane(
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
              {props.paneMaximized ? (
                <button
                  type="button"
                  onClick={props.onRestoreConversation}
                  className="mr-1 truncate rounded-lg px-2 py-1 text-left text-sm font-medium hover:bg-zinc-900"
                >
                  {title}
                </button>
              ) : null}
              <PaneTabButton
                label="Files"
                active={props.paneTab.type === "files"}
                onClick={() => props.onPaneTab({ type: "files" })}
              />
              <PaneTabButton
                label="Graph"
                active={props.paneTab.type === "graph"}
                onClick={() => props.onPaneTab({ type: "graph" })}
              />
              <PaneTabButton
                label="Settings"
                active={props.paneTab.type === "settings"}
                onClick={() => props.onPaneTab({ type: "settings" })}
              />
              {props.fileTabs.map((file) => (
                <span
                  key={file.path}
                  className={[
                    "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs",
                    props.paneTab.type === "file" &&
                    props.paneTab.path === file.path
                      ? "bg-zinc-800 text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  ].join(" ")}
                >
                  <button
                    type="button"
                    onClick={() =>
                      props.onPaneTab({ type: "file", path: file.path })
                    }
                    className="font-mono"
                  >
                    {file.title}
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${file.title}`}
                    onClick={() => props.onCloseFileTab(file.path)}
                    className="rounded p-0.5 hover:bg-zinc-700"
                  >
                    <IconX className="size-3" aria-hidden />
                  </button>
                </span>
              ))}
              <div className="flex-1" />
              {activeFile &&
              props.paneTab.type !== "graph" &&
              props.paneTab.type !== "settings" ? (
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
                  props.paneMaximized ? "Show conversation" : "Maximise pane"
                }
                onPress={props.onToggleMaximize}
              >
                {props.paneMaximized ? (
                  <IconArrowsMinimize className="size-4" aria-hidden />
                ) : (
                  <IconArrowsMaximize className="size-4" aria-hidden />
                )}
              </Button>
              <Button
                variant="quiet"
                size="icon-sm"
                aria-label="Close pane"
                onPress={props.onClosePane}
              >
                <IconX className="size-4" aria-hidden />
              </Button>
            </div>
            <div className="flex min-h-0 flex-1">
              {props.paneTab.type === "files" ||
              props.paneTab.type === "file" ? (
                <>
                  {props.treeCollapsed ? null : (
                    <div className="w-44 shrink-0 border-r border-border">
                      <FileTree
                        selectedPath={activeFile?.path ?? null}
                        collapsed={false}
                        onSelect={props.onSelectFile}
                        onOpenTab={props.onOpenFileTab}
                      />
                    </div>
                  )}
                  <div className="min-w-0 flex-1 overflow-auto">
                    <FilePreview file={activeFile} />
                  </div>
                </>
              ) : null}
              {props.paneTab.type === "graph" ? <GraphStub /> : null}
              {props.paneTab.type === "settings" ? (
                <SettingsStub
                  repo={selected?.repo ?? null}
                  readonly={Boolean(selected?.readonly)}
                  linkedRepos={selected?.linkedRepos ?? []}
                  onCreate={props.onAddWorkspace}
                />
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>

      {props.paletteOpen ? (
        <div className="absolute inset-0 z-40 flex items-start justify-center bg-black/50 pt-24">
          <button
            type="button"
            aria-label="Close search"
            className="absolute inset-0 cursor-default"
            onClick={props.onTogglePalette}
          />
          <div
            role="dialog"
            aria-label="Search"
            className="relative w-[32rem] rounded-lg border border-border bg-zinc-900 p-3"
          >
            <p className="px-2 text-xs text-muted-foreground">Jump to · ⌘K</p>
            <button
              type="button"
              className="mt-2 w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-zinc-800"
              onClick={() => {
                props.onOpenPane({ type: "files" })
                props.onTogglePalette()
              }}
            >
              Files
            </button>
            <button
              type="button"
              className="w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-zinc-800"
              onClick={() => {
                props.onOpenPane({ type: "graph" })
                props.onTogglePalette()
              }}
            >
              Graph
            </button>
            <button
              type="button"
              className="w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-zinc-800"
              onClick={() => {
                props.onOpenPane({ type: "settings" })
                props.onTogglePalette()
              }}
            >
              Settings · repository and linked remotes
            </button>
            {props.workspaces.flatMap((workspace) =>
              workspace.conversations.slice(0, 3).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="w-full rounded-lg px-2 py-2 text-left text-sm text-muted-foreground hover:bg-zinc-800 hover:text-foreground"
                  onClick={() => {
                    props.onSelectConversation(workspace.id, item.id)
                    props.onTogglePalette()
                  }}
                >
                  {workspace.name} · {item.name}
                </button>
              )),
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function NavRow(props: {
  icon: ReactNode
  label: string
  trailing?: ReactNode
  onClick?: () => void
}) {
  const className =
    "flex h-10 w-full items-center gap-3 px-5 text-sm text-muted-foreground hover:bg-zinc-900 hover:text-foreground"
  const inner = (
    <>
      <span className="flex size-5 shrink-0 items-center justify-center *:size-5 *:stroke-[1.4]">
        {props.icon}
      </span>
      <span className="min-w-0 truncate">{props.label}</span>
      {props.trailing}
    </>
  )
  return (
    <li>
      {props.onClick ? (
        <button type="button" onClick={props.onClick} className={className}>
          {inner}
        </button>
      ) : (
        <span className={className}>{inner}</span>
      )}
    </li>
  )
}

function WorkspaceGlyph(props: { open: boolean; collapsible: boolean }) {
  if (!props.collapsible) {
    return (
      <IconFolder
        className="size-5 shrink-0 stroke-[1.4] text-muted-foreground"
        aria-hidden
      />
    )
  }
  const Caret = props.open ? IconChevronDown : IconChevronRight
  return (
    <span className="relative size-5 shrink-0">
      <IconFolder
        className="size-5 stroke-[1.4] text-muted-foreground transition-opacity group-hover/ws-title:opacity-0"
        aria-hidden
      />
      <Caret
        className="absolute inset-0 size-5 stroke-[1.4] text-muted-foreground opacity-0 transition-opacity group-hover/ws-title:opacity-100"
        aria-hidden
      />
    </span>
  )
}

function HeaderIcon(props: {
  label: string
  icon: ReactNode
  onClick: () => void
}) {
  return (
    <Button
      variant="quiet"
      size="icon-sm"
      aria-label={props.label}
      onPress={props.onClick}
    >
      <span className="*:size-4">{props.icon}</span>
    </Button>
  )
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
