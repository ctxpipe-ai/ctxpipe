import type { ReactNode } from "react"
import { OverlayNavMenuButton } from "@/components/OverlayNavButton"
import { cn } from "@/lib/utils"
import type { Workspace } from "./types"
import {
  workspaceChromeCardClassName,
  workspaceChromeOuterClassName,
  workspaceChromeOuterFlushClassName,
  workspaceChromeTabClassName,
  workspaceChromeTabStripClassName,
} from "./workspaceChrome"

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
    <div
      className={cn(
        workspaceChromeOuterClassName,
        workspaceChromeOuterFlushClassName,
        "h-full min-w-0 flex-1 pl-0 pr-3",
      )}
      data-workspace-surface=""
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className={cn(
            workspaceChromeTabStripClassName,
            "max-md:pl-1 max-md:pr-2",
          )}
        >
          <div className="mb-px flex shrink-0 self-end pb-0.5 md:hidden">
            <OverlayNavMenuButton />
          </div>
          <div className={cn(workspaceChromeTabClassName, "max-w-[min(100%,24rem)]")}>
            {typeof props.title === "string" ? (
              <p className="min-w-0 truncate">{props.title}</p>
            ) : (
              props.title
            )}
          </div>
          {props.headerExtra || props.workspace.readOnlyReason ? (
            <div className="ml-auto flex min-w-0 items-end gap-0.5">
              {props.workspace.readOnlyReason ? (
                <span
                  title={props.workspace.readOnlyReason}
                  className="shrink-0 self-center rounded-lg border border-amber-500/80 bg-amber-950 px-2 py-0.5 text-xs font-medium text-amber-200"
                >
                  Read-only
                </span>
              ) : null}
              {props.headerExtra}
            </div>
          ) : null}
        </div>

        <div className={workspaceChromeCardClassName}>{props.children}</div>
      </div>
    </div>
  )
}
