import { IconDots, IconPlus } from "@tabler/icons-react"
import { Logo } from "@/components/Logo/Logo"
import type { KnowledgeFile, RightTab, Workspace } from "./mock"
import {
  ChatTranscript,
  CreateWorkspacePrompt,
  FilePreview,
  GraphStub,
  SettingsStub,
} from "./stubs"

export const variantName = "Work queue"

export function VariantWorkQueue(props: {
  workspaces: Workspace[]
  selectedWorkspaceId: string | null
  selectedConversationId: string | null
  rightTab: RightTab
  selectedFile: KnowledgeFile | null
  onSelectWorkspace: (id: string) => void
  onSelectConversation: (workspaceId: string, conversationId: string) => void
  onNewConversation: (workspaceId: string) => void
  onAddWorkspace: () => void
  onRightTab: (tab: RightTab) => void
  onSelectFile: (file: KnowledgeFile) => void
}) {
  const selected = props.workspaces.find(
    (w) => w.id === props.selectedWorkspaceId,
  )
  const conversation = selected?.conversations.find(
    (c) => c.id === props.selectedConversationId,
  )
  const emptyOrg = props.workspaces.length === 0
  const tab = props.rightTab === "files" ? "changes" : props.rightTab

  return (
    <div className="flex min-h-screen bg-[#0b0b0c] text-zinc-100">
      <nav className="flex w-72 shrink-0 flex-col border-r border-zinc-800">
        <div className="flex items-center justify-between px-4 py-4">
          <Logo aria-hidden className="h-5 w-auto" />
          <button
            type="button"
            aria-label="Add Workspace"
            onClick={props.onAddWorkspace}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <IconPlus className="h-4 w-4" />
          </button>
        </div>
        <p className="px-4 text-[11px] uppercase tracking-[0.16em] text-zinc-500">
          Workspaces
        </p>
        <div className="mt-2 flex-1 overflow-auto px-2">
          {props.workspaces.map((workspace) => (
            <div key={workspace.id} className="mb-3">
              <button
                type="button"
                onClick={() => props.onSelectWorkspace(workspace.id)}
                className={[
                  "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm",
                  selected?.id === workspace.id
                    ? "bg-zinc-800 text-zinc-50"
                    : "text-zinc-300 hover:bg-zinc-900",
                ].join(" ")}
              >
                <span className="truncate">{workspace.name}</span>
                <span className="font-mono text-[10px] text-zinc-500">
                  {workspace.conversations.length}
                </span>
              </button>
              <ul className="mt-1 space-y-0.5 pl-2">
                {workspace.conversations.length === 0 ? (
                  <li className="px-2 py-1 text-xs text-zinc-600">
                    No conversations yet
                  </li>
                ) : (
                  workspace.conversations.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() =>
                          props.onSelectConversation(workspace.id, item.id)
                        }
                        className={[
                          "w-full truncate rounded px-2 py-1 text-left text-xs",
                          conversation?.id === item.id
                            ? "bg-zinc-800/80 text-zinc-100"
                            : "text-zinc-500 hover:text-zinc-300",
                        ].join(" ")}
                      >
                        {item.name}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
          ))}
        </div>
        <details className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
          <summary className="cursor-pointer text-zinc-400">
            Org · Home / Repositories / Connectors
          </summary>
          <p className="mt-2 leading-relaxed">
            Proposal: keep these under an Org drawer. They are not the product
            home anymore.
          </p>
        </details>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-zinc-800 px-5">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {conversation?.name ?? "What should we get done?"}
            </p>
            <p className="font-mono text-[11px] text-zinc-500">
              {selected?.repo ?? "no workspace repository"}
            </p>
          </div>
          {selected?.readonly ? (
            <span
              title={selected.readonlyReason ?? "Read-only"}
              className="shrink-0 rounded-full border border-amber-500 bg-amber-950 px-2 py-0.5 text-[11px] font-medium text-amber-200"
            >
              Read-only
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {(
              [
                ["changes", "Code changes"],
                ["graph", "Graph"],
                ["settings", "Settings"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() =>
                  props.onRightTab(key === "changes" ? "files" : key)
                }
                className={[
                  "rounded px-2 py-1 text-xs",
                  tab === key
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300",
                ].join(" ")}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300"
            >
              Open PR
            </button>
            {selected ? (
              <button
                type="button"
                onClick={() => props.onNewConversation(selected.id)}
                className="rounded-md bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-950"
              >
                New
              </button>
            ) : null}
            <IconDots className="h-4 w-4 text-zinc-600" />
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
          <aside className="flex w-[22rem] min-w-0 shrink-0 flex-col border-l border-zinc-800">
            <div className="min-h-0 flex-1 overflow-auto">
              {tab === "changes" ? (
                <div>
                  <button
                    type="button"
                    onClick={() =>
                      props.onSelectFile({
                        path: "knowledge/hydrate/cas.md",
                        title: "Hydrate CAS",
                        body: "+ Hydrate never writes git.\n+ Jobs are the writers.",
                      })
                    }
                    className="w-full border-b border-zinc-800 px-4 py-2 text-left font-mono text-xs text-teal-300 hover:bg-zinc-900"
                  >
                    knowledge/hydrate/cas.md
                  </button>
                  <FilePreview
                    file={
                      props.selectedFile ?? {
                        path: "diff",
                        title: "diff",
                        body: "No file tree. This pane is the changed-file diff — Codex-style.",
                      }
                    }
                  />
                </div>
              ) : null}
              {tab === "graph" ? <GraphStub /> : null}
              {tab === "settings" ? (
                <SettingsStub
                  repo={selected?.repo ?? null}
                  readonly={Boolean(selected?.readonly)}
                  linkedRepos={selected?.linkedRepos ?? []}
                  onCreate={props.onAddWorkspace}
                />
              ) : null}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
