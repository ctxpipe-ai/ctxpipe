import type { ReactNode } from "react"
import type { Workspace } from "./types"

/**
 * Conversation column chrome: card surface with the conversation name as an
 * active tab (conversation is one pane; files/graph/settings are the other).
 */
export function WorkspaceChatChrome(props: {
  workspace: Workspace
  title: ReactNode
  headerExtra?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col pb-3 pl-0 pr-3 pt-[6.5px]">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-end gap-2">
          <div
            className={[
              "relative z-10 -mb-px max-w-[min(100%,24rem)] shrink-0",
              "rounded-t-lg border border-b-0 border-white/[0.06] bg-card px-3 py-2",
            ].join(" ")}
          >
            {typeof props.title === "string" ? (
              <p className="truncate text-sm font-medium text-foreground">
                {props.title}
              </p>
            ) : (
              props.title
            )}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-2 self-end">
            {props.workspace.readOnlyReason ? (
              <span
                title={props.workspace.readOnlyReason}
                className="shrink-0 rounded-lg border border-amber-500/80 bg-amber-950 px-2 py-0.5 text-xs font-medium text-amber-200"
              >
                Read-only
              </span>
            ) : null}
            {props.headerExtra}
          </div>
        </div>

        <div
          className={[
            "relative flex min-h-0 flex-1 flex-col overflow-hidden",
            "rounded-lg rounded-tl-none border border-white/[0.06]",
            "bg-card text-card-foreground",
          ].join(" ")}
        >
          {props.children}
        </div>
      </div>
    </div>
  )
}
