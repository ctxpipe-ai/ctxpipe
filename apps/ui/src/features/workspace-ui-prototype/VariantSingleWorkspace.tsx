import {
  IconAffiliate,
  IconFiles,
  IconGitBranch,
  IconHome,
  IconPlug,
  IconPlus,
  IconSearch,
  IconSettings,
  IconX,
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

export const variantName = "Single workspace"

export function VariantSingleWorkspace(props: {
  workspaces: Workspace[]
  selectedWorkspaceId: string | null
  selectedConversationId: string | null
  rightTab: RightTab | null
  selectedFile: KnowledgeFile | null
  paletteOpen: boolean
  onSelectWorkspace: (id: string) => void
  onSelectConversation: (workspaceId: string, conversationId: string) => void
  onNewConversation: (workspaceId: string) => void
  onAddWorkspace: () => void
  onRightTab: (tab: RightTab | null) => void
  onSelectFile: (file: KnowledgeFile) => void
  onOpenTab: (file: KnowledgeFile) => void
  onTogglePalette: () => void
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
      <aside className="flex w-14 flex-col items-center border-r border-zinc-800 py-3">
        <Logo aria-hidden className="mb-6 h-5 w-auto" />
        <IconBtn label="Home" icon={<IconHome />} />
        <IconBtn label="Repositories" icon={<IconGitBranch />} />
        <IconBtn label="Connectors" icon={<IconPlug />} />
        <div className="flex-1" />
        <IconBtn
          label="Command palette"
          icon={<IconSearch />}
          onClick={props.onTogglePalette}
        />
      </aside>

      <nav className="flex w-64 shrink-0 flex-col border-r border-zinc-800">
        <label className="block border-b border-zinc-800 px-3 py-3">
          <span className="text-[11px] uppercase tracking-wide text-zinc-500">
            Workspace
          </span>
          <select
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
            value={selected?.id ?? ""}
            onChange={(event) => {
              if (event.target.value === "__create") {
                props.onAddWorkspace()
                return
              }
              if (event.target.value)
                props.onSelectWorkspace(event.target.value)
            }}
          >
            {emptyOrg ? <option value="">Create a Workspace…</option> : null}
            {props.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
            <option value="__create">+ New Workspace</option>
          </select>
        </label>
        {selected ? (
          <button
            type="button"
            onClick={() => props.onNewConversation(selected.id)}
            className="mx-3 mt-3 inline-flex items-center justify-center gap-1 rounded-md border border-zinc-700 py-1.5 text-sm text-zinc-200 hover:bg-zinc-900"
          >
            <IconPlus className="h-4 w-4" /> New conversation
          </button>
        ) : null}
        <p className="mt-4 px-3 text-[11px] uppercase tracking-wide text-zinc-500">
          Recents
        </p>
        <ul className="mt-1 flex-1 overflow-auto px-2">
          {(selected?.conversations ?? []).map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() =>
                  selected && props.onSelectConversation(selected.id, item.id)
                }
                className={[
                  "w-full truncate rounded px-2 py-1.5 text-left text-sm",
                  conversation?.id === item.id
                    ? "bg-zinc-800 text-zinc-50"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
                ].join(" ")}
              >
                {item.name}
              </button>
            </li>
          ))}
          {selected && selected.conversations.length === 0 ? (
            <li className="px-2 py-2 text-xs text-zinc-600">
              No conversations in this Workspace
            </li>
          ) : null}
        </ul>
      </nav>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-2 border-b border-zinc-800 px-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {conversation?.name ?? selected?.name ?? "Create a Workspace"}
            </p>
            <p className="truncate font-mono text-[11px] text-zinc-500">
              {selected?.repo ?? "no draft — create is link"}
            </p>
          </div>
          {selected?.readonly ? (
            <span
              title={selected.readonlyReason ?? "Read-only"}
              className="shrink-0 rounded border border-amber-500 bg-amber-950 px-2 py-0.5 text-[11px] font-medium text-amber-200"
            >
              Read-only
            </span>
          ) : null}
          <IconBtn
            label="Files"
            icon={<IconFiles />}
            onClick={() => props.onRightTab("files")}
          />
          <IconBtn
            label="Graph"
            icon={<IconAffiliate />}
            onClick={() => props.onRightTab("graph")}
          />
          <IconBtn
            label="Settings"
            icon={<IconSettings />}
            onClick={() => props.onRightTab("settings")}
          />
        </header>

        {emptyOrg ? (
          <CreateWorkspacePrompt onCreate={props.onAddWorkspace} />
        ) : (
          <ChatTranscript
            conversationName={conversation?.name ?? null}
            empty={!conversation}
          />
        )}

        {props.rightTab ? (
          <div className="absolute inset-y-12 right-0 z-20 flex w-[26rem] flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50">
            <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
              <p className="text-xs uppercase tracking-wide text-zinc-400">
                {props.rightTab}
              </p>
              <button
                type="button"
                aria-label="Close panel"
                onClick={() => props.onRightTab(null)}
                className="rounded p-1 text-zinc-500 hover:text-zinc-200"
              >
                <IconX className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {props.rightTab === "files" ? (
                <div className="flex h-full">
                  <div className="w-40 border-r border-zinc-800">
                    <FileTree
                      selectedPath={props.selectedFile?.path ?? null}
                      collapsed={false}
                      onSelect={props.onSelectFile}
                      onOpenTab={props.onOpenTab}
                    />
                  </div>
                  <FilePreview file={props.selectedFile} />
                </div>
              ) : null}
              {props.rightTab === "graph" ? <GraphStub /> : null}
              {props.rightTab === "settings" ? (
                <SettingsStub
                  repo={selected?.repo ?? null}
                  readonly={Boolean(selected?.readonly)}
                  linkedRepos={selected?.linkedRepos ?? []}
                  onCreate={props.onAddWorkspace}
                />
              ) : null}
            </div>
          </div>
        ) : null}

        {props.paletteOpen ? (
          <div className="absolute inset-0 z-30 flex items-start justify-center bg-black/50 pt-24">
            <div className="w-[32rem] rounded-xl border border-zinc-700 bg-zinc-900 p-3 shadow-2xl">
              <p className="px-2 text-xs text-zinc-500">Jump to</p>
              <button
                type="button"
                className="mt-2 w-full rounded px-2 py-2 text-left text-sm hover:bg-zinc-800"
                onClick={() => {
                  props.onRightTab("files")
                  props.onTogglePalette()
                }}
              >
                Files
              </button>
              <button
                type="button"
                className="w-full rounded px-2 py-2 text-left text-sm hover:bg-zinc-800"
                onClick={() => {
                  props.onRightTab("graph")
                  props.onTogglePalette()
                }}
              >
                Graph
              </button>
              <button
                type="button"
                className="w-full rounded px-2 py-2 text-left text-sm hover:bg-zinc-800"
                onClick={() => {
                  props.onRightTab("settings")
                  props.onTogglePalette()
                }}
              >
                Settings · create / select / relink
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function IconBtn(props: {
  label: string
  icon: ReactNode
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      onClick={props.onClick}
      className="mb-1 rounded-md p-2 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
    >
      <span className="block *:h-5 *:w-5 *:stroke-[1.4]">{props.icon}</span>
    </button>
  )
}
