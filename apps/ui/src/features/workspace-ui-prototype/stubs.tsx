import { CHAT_TURNS, KNOWLEDGE_FILES, type KnowledgeFile } from "./mock"

export function ChatTranscript(props: {
  conversationName: string | null
  empty: boolean
}) {
  if (props.empty) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <p className="text-lg font-medium text-zinc-100">New conversation</p>
        <p className="mt-2 max-w-md text-sm text-zinc-400">
          Ask about this Workspace. The name becomes the first user message.
        </p>
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-auto px-6 py-5">
        {CHAT_TURNS.map((turn) => (
          <div
            key={turn.text}
            className={
              turn.role === "user"
                ? "ml-12 rounded-lg bg-zinc-800/80 px-3 py-2 text-sm text-zinc-100"
                : "mr-8 text-sm leading-relaxed text-zinc-300"
            }
          >
            {turn.text}
          </div>
        ))}
      </div>
      <div className="border-t border-zinc-800 px-4 py-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-500">
          Message {props.conversationName ?? "this Workspace"}…
        </div>
      </div>
    </div>
  )
}

export function FileTree(props: {
  selectedPath: string | null
  collapsed: boolean
  onSelect: (file: KnowledgeFile) => void
  onOpenTab: (file: KnowledgeFile) => void
}) {
  if (props.collapsed) return null
  return (
    <ul className="space-y-0.5 p-2 text-sm">
      {KNOWLEDGE_FILES.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            onClick={() => props.onSelect(file)}
            onDoubleClick={() => props.onOpenTab(file)}
            className={[
              "w-full rounded px-2 py-1 text-left font-mono text-xs",
              props.selectedPath === file.path
                ? "bg-teal-900/40 text-zinc-50"
                : "text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-200",
            ].join(" ")}
          >
            {file.path}
          </button>
        </li>
      ))}
    </ul>
  )
}

export function FilePreview(props: { file: KnowledgeFile | null }) {
  if (!props.file) {
    return (
      <p className="p-4 text-sm text-zinc-500">
        Select a file to preview. Double-click opens another tab.
      </p>
    )
  }
  return (
    <div className="p-4">
      <p className="font-mono text-xs text-zinc-500">{props.file.path}</p>
      <pre className="mt-3 whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-300">
        {props.file.body}
      </pre>
    </div>
  )
}

export function GraphStub() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-sm font-medium text-zinc-200">Workspace graph</p>
      <p className="max-w-sm text-xs text-zinc-500">
        Projection of this Workspace only — not the old org-wide graph.
      </p>
      <div className="mt-4 grid grid-cols-3 gap-6 opacity-70">
        {["cas.md", "brokered-pr.md", "backend.md"].map((label) => (
          <span
            key={label}
            className="rounded-full border border-teal-700/60 bg-teal-950/40 px-3 py-2 font-mono text-[11px] text-teal-200"
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}

export function SettingsStub(props: {
  repo: string | null
  readonly: boolean
  onCreate: () => void
}) {
  return (
    <div className="space-y-5 overflow-auto p-5 text-sm">
      <div>
        <p className="text-xs uppercase tracking-wide text-zinc-500">
          Workspace repository
        </p>
        <p className="mt-1 font-mono text-zinc-200">
          {props.repo ?? "None — create is link"}
        </p>
        {props.readonly ? (
          <p className="mt-2 text-amber-300">
            Read-only. Jobs that maintain this URL are paused.
          </p>
        ) : null}
      </div>
      <label className="block">
        <span className="text-xs text-zinc-500">Select installation repo</span>
        <select className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-200">
          <option>acme/platform-context</option>
          <option>acme/billing-context</option>
          <option>acme/onboarding-context</option>
        </select>
      </label>
      <button
        type="button"
        onClick={props.onCreate}
        className="w-full rounded border border-zinc-700 px-3 py-2 text-left text-zinc-200 hover:bg-zinc-800"
      >
        Create on GitHub… then select
      </button>
      <label className="block">
        <span className="text-xs text-zinc-500">Paste any git URL</span>
        <input
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-200"
          placeholder="git@gitlab.com:acme/context.git"
        />
      </label>
      <button
        type="button"
        className="w-full rounded border border-zinc-700 px-3 py-2 text-left text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
      >
        Relink this Workspace
      </button>
    </div>
  )
}

export function StateDump(props: {
  variant: string
  scene: string
  workspace: string | null
  conversation: string | null
  branch: string | null
  tab: string | null
  file: string | null
}) {
  return (
    <pre className="pointer-events-none fixed bottom-28 left-3 z-[70] max-w-xs rounded border border-amber-500/40 bg-zinc-950/90 p-2 font-mono text-[10px] leading-relaxed text-amber-100/90">
      {JSON.stringify(props, null, 2)}
    </pre>
  )
}

export function CreateWorkspacePrompt(props: { onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <p className="text-xl font-medium text-zinc-50">Create a Workspace</p>
      <p className="mt-3 max-w-md text-sm text-zinc-400">
        There is no draft. Linking or creating a workspace repository is create.
        Finishing this will auto-link unlinked repositories.
      </p>
      <button
        type="button"
        onClick={props.onCreate}
        className="mt-6 rounded-lg bg-teal-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-teal-400"
      >
        Create Workspace
      </button>
    </div>
  )
}
