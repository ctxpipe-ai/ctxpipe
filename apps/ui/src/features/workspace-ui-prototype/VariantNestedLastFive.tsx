import {
  IconAffiliate,
  IconChevronDown,
  IconChevronRight,
  IconFiles,
  IconGitBranch,
  IconHome,
  IconPlug,
  IconPlus,
  IconSettings,
} from "@tabler/icons-react"
import type { ReactNode } from "react"
import { Logo } from "@/components/Logo/Logo"
import type { KnowledgeFile, RightTab, Workspace } from "./mock"
import {
  ChatTranscript,
  CreateWorkspacePrompt,
  FilePreview,
  FileTree,
  GraphStub,
  SettingsStub,
} from "./stubs"

export const variantName = "Nested last-5"

export function VariantNestedLastFive(props: {
  workspaces: Workspace[]
  selectedWorkspaceId: string | null
  selectedConversationId: string | null
  expandedIds: string[]
  rightTab: RightTab
  selectedFile: KnowledgeFile | null
  openTabs: KnowledgeFile[]
  treeCollapsed: boolean
  onSelectWorkspace: (id: string) => void
  onToggleExpand: (id: string) => void
  onSelectConversation: (workspaceId: string, conversationId: string) => void
  onNewConversation: (workspaceId: string) => void
  onAddWorkspace: () => void
  onRightTab: (tab: RightTab) => void
  onSelectFile: (file: KnowledgeFile) => void
  onOpenTab: (file: KnowledgeFile) => void
  onToggleTree: () => void
}) {
  const selected = props.workspaces.find(
    (w) => w.id === props.selectedWorkspaceId,
  )
  const conversation = selected?.conversations.find(
    (c) => c.id === props.selectedConversationId,
  )
  const emptyOrg = props.workspaces.length === 0

  return (
    <div className="flex min-h-screen bg-zinc-950 text-zinc-100">
      <nav className="flex w-56 shrink-0 flex-col border-r border-zinc-800/80">
        <div className="px-3.5 py-4">
          <Logo aria-hidden className="h-5 w-auto" />
        </div>
        <ul className="space-y-1 text-sm">
          <NavRow icon={<IconHome />} label="Home" />
          <NavRow icon={<IconGitBranch />} label="Repositories" />
          <NavRow icon={<IconPlug />} label="Connectors" />
        </ul>
        <div className="mt-6 px-3">
          <div className="group/ws flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Workspaces
            </p>
            <button
              type="button"
              aria-label="Add Workspace"
              onClick={props.onAddWorkspace}
              className="rounded p-0.5 text-zinc-500 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 group-hover/ws:opacity-100"
            >
              <IconPlus className="h-3.5 w-3.5" />
            </button>
          </div>
          <ul className="mt-2 space-y-0.5">
            {props.workspaces.map((workspace) => {
              const open = props.expandedIds.includes(workspace.id)
              const lastFive = workspace.conversations.slice(0, 5)
              return (
                <li key={workspace.id}>
                  <div className="flex items-center">
                    <button
                      type="button"
                      onClick={() => props.onSelectWorkspace(workspace.id)}
                      className={[
                        "min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm",
                        selected?.id === workspace.id
                          ? "bg-teal-900/30 text-zinc-50"
                          : "text-zinc-300 hover:bg-zinc-900",
                      ].join(" ")}
                    >
                      {workspace.name}
                    </button>
                    <button
                      type="button"
                      aria-label={
                        open
                          ? `Hide conversations in ${workspace.name}`
                          : `Show last conversations in ${workspace.name}`
                      }
                      onClick={() => props.onToggleExpand(workspace.id)}
                      className="rounded p-1 text-zinc-500 hover:text-zinc-200"
                    >
                      {open ? (
                        <IconChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <IconChevronRight className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                  {open ? (
                    <ul className="mb-1 ml-3 border-l border-zinc-800 pl-2">
                      {lastFive.length === 0 ? (
                        <li className="px-2 py-1 text-xs text-zinc-600">
                          No conversations
                        </li>
                      ) : (
                        lastFive.map((item) => (
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
                                "w-full truncate rounded px-2 py-1 text-left text-xs",
                                conversation?.id === item.id
                                  ? "text-teal-300"
                                  : "text-zinc-500 hover:text-zinc-300",
                              ].join(" ")}
                            >
                              {item.name}
                            </button>
                          </li>
                        ))
                      )}
                    </ul>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>
        <div className="flex-1" />
        <p className="px-4 py-3 text-xs text-zinc-600">acme · you</p>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-3 border-b border-zinc-800/80 px-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {conversation?.name ??
                selected?.name ??
                (emptyOrg ? "No Workspace" : "Workspace")}
            </p>
            <p className="truncate font-mono text-[11px] text-zinc-500">
              {selected
                ? `${selected.repo}${conversation ? ` · ${conversation.lastBranch}` : ""}`
                : "Create is link — no draft"}
            </p>
          </div>
          {selected?.readonly ? (
            <span
              title={selected.readonlyReason ?? "Read-only Workspace"}
              className="rounded border border-amber-700/70 px-2 py-0.5 text-[11px] text-amber-300"
            >
              Read-only
            </span>
          ) : null}
          {selected ? (
            <button
              type="button"
              onClick={() => props.onNewConversation(selected.id)}
              className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              New conversation
            </button>
          ) : null}
          <div className="ml-auto flex gap-1">
            {(
              [
                ["files", IconFiles, "Files"],
                ["graph", IconAffiliate, "Graph"],
                ["settings", IconSettings, "Settings"],
              ] as const
            ).map(([tab, Icon, label]) => (
              <button
                key={tab}
                type="button"
                onClick={() => props.onRightTab(tab)}
                className={[
                  "inline-flex items-center gap-1 rounded px-2 py-1 text-xs",
                  props.rightTab === tab
                    ? "bg-zinc-800 text-zinc-50"
                    : "text-zinc-500 hover:text-zinc-200",
                ].join(" ")}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <section className="min-w-0 flex-1">
            {emptyOrg ? (
              <CreateWorkspacePrompt onCreate={props.onAddWorkspace} />
            ) : (
              <ChatTranscript
                conversationName={conversation?.name ?? null}
                empty={!conversation}
              />
            )}
          </section>
          <aside className="flex w-[22rem] shrink-0 flex-col border-l border-zinc-800/80">
            {props.rightTab === "files" ? (
              <>
                <div className="flex gap-1 overflow-auto border-b border-zinc-800 px-2 py-1">
                  {props.selectedFile && props.treeCollapsed ? (
                    <button
                      type="button"
                      onClick={props.onToggleTree}
                      className="rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800"
                    >
                      Tree
                    </button>
                  ) : null}
                  {props.openTabs.map((tab) => (
                    <span
                      key={tab.path}
                      className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-300"
                    >
                      {tab.title}
                    </span>
                  ))}
                </div>
                <div className="flex min-h-0 flex-1">
                  <div className="w-40 shrink-0 border-r border-zinc-800">
                    <FileTree
                      selectedPath={props.selectedFile?.path ?? null}
                      collapsed={props.treeCollapsed}
                      onSelect={props.onSelectFile}
                      onOpenTab={props.onOpenTab}
                    />
                  </div>
                  <div className="min-w-0 flex-1 overflow-auto">
                    <FilePreview file={props.selectedFile} />
                  </div>
                </div>
              </>
            ) : null}
            {props.rightTab === "graph" ? <GraphStub /> : null}
            {props.rightTab === "settings" ? (
              <SettingsStub
                repo={selected?.repo ?? null}
                readonly={Boolean(selected?.readonly)}
                onCreate={props.onAddWorkspace}
              />
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  )
}

function NavRow(props: { icon: ReactNode; label: string }) {
  return (
    <li>
      <span className="flex h-10 items-center gap-3 px-5 text-zinc-400">
        <span className="*:h-5 *:w-5 *:stroke-[1.4]">{props.icon}</span>
        {props.label}
      </span>
    </li>
  )
}
