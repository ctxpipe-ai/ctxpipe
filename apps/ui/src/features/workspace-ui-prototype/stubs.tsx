import {
  IconArrowUp,
  IconChevronDown,
  IconPaperclip,
} from "@tabler/icons-react"
import { Button } from "@/components/ui/Button"
import { CHAT_TURNS, KNOWLEDGE_FILES, type KnowledgeFile } from "./mock"

export function ChatTranscript(props: {
  conversationName: string | null
  empty: boolean
}) {
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {props.empty ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 pb-36 text-center">
          <h1 className="text-lg font-medium text-foreground">
            New conversation
          </h1>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">
            Ask about this Workspace. The name becomes the first user message.
          </p>
        </div>
      ) : (
        <div className="flex-1 space-y-4 overflow-auto px-6 py-5 pb-36">
          {CHAT_TURNS.map((turn) => (
            <div
              key={turn.text}
              className={
                turn.role === "user"
                  ? "ml-12 rounded-lg bg-zinc-900 px-3 py-2 text-sm text-foreground"
                  : "mr-8 text-sm leading-relaxed text-muted-foreground"
              }
            >
              {turn.text}
            </div>
          ))}
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-28">
        <div className="pointer-events-auto mx-auto max-w-3xl rounded-lg border border-border bg-zinc-900">
          <textarea
            rows={3}
            placeholder={
              props.empty
                ? "Ask anything…"
                : `Continue ${props.conversationName ?? "this Workspace"}…`
            }
            className="min-h-20 w-full resize-none bg-transparent px-4 pt-3 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-2 px-3 pb-3">
            <button
              type="button"
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-zinc-800 hover:text-foreground"
              aria-label="Add context"
            >
              <IconPaperclip className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-zinc-800 hover:text-foreground"
            >
              Agent
              <IconChevronDown className="size-3.5" aria-hidden />
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-mono text-xs text-muted-foreground hover:bg-zinc-800 hover:text-foreground"
            >
              Grok 4.6
              <IconChevronDown className="size-3.5" aria-hidden />
            </button>
            <div className="flex-1" />
            <Button
              variant="primary"
              size="icon-sm"
              aria-label="Send"
              className="rounded-lg"
            >
              <IconArrowUp className="size-4" aria-hidden />
            </Button>
          </div>
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
              "w-full rounded-lg px-2 py-1 text-left font-mono text-xs",
              props.selectedPath === file.path
                ? "bg-zinc-800 text-foreground"
                : "text-muted-foreground hover:bg-zinc-900 hover:text-foreground",
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
      <p className="p-4 text-sm text-muted-foreground">
        Select a file to preview. Double-click opens it in a new tab.
      </p>
    )
  }
  return (
    <div className="p-4">
      <p className="font-mono text-xs text-muted-foreground">
        {props.file.path}
      </p>
      <pre className="mt-3 whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">
        {props.file.body}
      </pre>
    </div>
  )
}

export function GraphStub() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-sm font-medium text-foreground">Workspace graph</p>
      <p className="max-w-prose text-xs text-muted-foreground">
        Projection of this Workspace only — not the old org-wide graph.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-3">
        {["cas.md", "brokered-pr.md", "backend.md"].map((label) => (
          <span
            key={label}
            className="rounded-lg border border-border bg-zinc-900 px-3 py-2 font-mono text-xs text-muted-foreground"
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
  linkedRepos: string[]
  onCreate: () => void
}) {
  return (
    <div className="max-w-md space-y-6 overflow-auto p-5 text-sm">
      <section>
        <p className="ctx-label text-muted-foreground">Workspaces</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Add another Context Workspace. Create is link — no draft.
        </p>
        <Button
          variant="outline"
          onPress={props.onCreate}
          className="mt-3 w-full"
        >
          Add Workspace
        </Button>
      </section>
      <section>
        <p className="ctx-label text-muted-foreground">Workspace repository</p>
        <p className="mt-2 font-mono text-sm text-foreground">
          {props.repo ?? "None — create is link"}
        </p>
        {props.readonly ? (
          <p className="mt-2 text-sm text-amber-200">
            Read-only. Jobs that maintain this URL are paused.
          </p>
        ) : null}
      </section>
      <label className="block">
        <span className="text-xs text-muted-foreground">
          Select installation repo
        </span>
        <select className="mt-1 w-full rounded-lg border border-border bg-zinc-900 px-2 py-1.5 text-foreground">
          <option>acme/platform-context</option>
          <option>acme/billing-context</option>
          <option>acme/onboarding-context</option>
        </select>
      </label>
      <Button variant="outline" onPress={props.onCreate} className="w-full">
        Create on GitHub… then select
      </Button>
      <label className="block">
        <span className="text-xs text-muted-foreground">Paste any git URL</span>
        <input
          className="mt-1 w-full rounded-lg border border-border bg-zinc-900 px-2 py-1.5 font-mono text-xs text-foreground"
          placeholder="git@gitlab.com:acme/context.git"
        />
      </label>
      <Button variant="ghost" className="w-full justify-start">
        Relink this Workspace
      </Button>
      <section>
        <p className="ctx-label text-muted-foreground">Linked repositories</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Extra remotes for codesearch. There is no top-level Repositories page.
        </p>
        <ul className="mt-3 space-y-1">
          {props.linkedRepos.length === 0 ? (
            <li className="text-sm text-muted-foreground">None linked</li>
          ) : (
            props.linkedRepos.map((repo) => (
              <li
                key={repo}
                className="flex items-center justify-between rounded-lg px-2 py-1.5"
              >
                <span className="font-mono text-xs text-foreground">
                  {repo}
                </span>
                <Button variant="quiet">Unlink</Button>
              </li>
            ))
          )}
        </ul>
        <Button variant="outline" className="mt-3">
          Link a repository
        </Button>
      </section>
    </div>
  )
}

export function StateDump(
  props: Record<string, string | null | boolean | number>,
) {
  return (
    <pre className="pointer-events-none fixed bottom-28 left-3 z-[70] max-w-xs rounded-lg border border-amber-500/40 bg-zinc-950/90 p-2 font-mono text-[10px] leading-relaxed text-amber-100/90">
      {JSON.stringify(props, null, 2)}
    </pre>
  )
}

export function CreateWorkspacePrompt(props: { onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <h1 className="text-lg font-medium text-foreground">
        Create a Workspace
      </h1>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        There is no draft. Linking or creating a workspace repository is create.
        Finishing this will auto-link unlinked repositories.
      </p>
      <Button variant="primary" onPress={props.onCreate} className="mt-6">
        Create Workspace
      </Button>
    </div>
  )
}
