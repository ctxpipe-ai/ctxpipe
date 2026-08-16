import type { ReactNode } from "react"
import type { Workspace } from "./types"

export function WorkspaceChatChrome(props: {
  workspace: Workspace
  title: ReactNode
  headerExtra?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="min-w-0 flex-1">
          {typeof props.title === "string" ? (
            <p className="truncate text-sm font-medium">{props.title}</p>
          ) : (
            props.title
          )}
          <p className="truncate font-mono text-xs text-muted-foreground">
            {props.workspace.workspaceRepositoryUrl}
          </p>
        </div>
        {props.workspace.readOnlyReason ? (
          <span
            title={props.workspace.readOnlyReason}
            className="shrink-0 rounded-lg border border-amber-500 bg-amber-950 px-2 py-0.5 text-xs font-medium text-amber-200"
          >
            Read-only
          </span>
        ) : null}
        {props.headerExtra}
      </header>
      {props.children}
    </div>
  )
}
