import type { ReactNode } from "react"
import { Link as AriaLink } from "react-aria-components"
import { OverlayNavMenuButton } from "@/components/OverlayNavButton"
import { Button } from "@/components/ui/Button"
import { cn } from "@/lib/utils"
import type { Workspace } from "./types"
import {
  workspaceChromeCardClassName,
  workspaceChromeOuterClassName,
  workspaceChromeOuterFlushClassName,
  workspaceChromeTabClassName,
  workspaceChromeTabStripClassName,
} from "./workspaceChrome"
import { writeStatusLabel } from "./writeStatusLabel"

export type ConversationPublishChrome = {
  commitPush: {
    enabled: boolean
    pending: boolean
    onPress: () => void
  }
  pullRequest: {
    action: "create" | "show"
    pending: boolean
    href?: string | null
    onPress: () => void
  }
}

export type ConversationBranchChrome = {
  shortName: string
  fullRef: string
  href?: string | null
}

/**
 * Conversation column chrome: card surface with the conversation name as an
 * active tab (conversation is one pane; files/graph/settings are the other).
 */
export function WorkspaceChatChrome(props: {
  workspace: Workspace
  title: ReactNode
  headerExtra?: ReactNode
  branch?: ConversationBranchChrome | null
  publish?: ConversationPublishChrome | null
  children: ReactNode
}) {
  const write = writeStatusLabel(props.workspace.writeStatus)
  const showWriteBadge =
    !props.publish &&
    (write.tone === "read_only" || write.tone === "pending")
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
            {props.branch ? (
              props.branch.href ? (
                <AriaLink
                  href={props.branch.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-2 truncate font-mono text-xs text-muted-foreground hover:text-teal-400"
                  aria-label={props.branch.fullRef}
                >
                  {props.branch.shortName}
                </AriaLink>
              ) : (
                <span
                  title={props.branch.fullRef}
                  className="ml-2 truncate font-mono text-xs text-muted-foreground"
                >
                  {props.branch.shortName}
                </span>
              )
            ) : null}
          </div>
          {props.headerExtra || showWriteBadge || props.publish ? (
            <div className="ml-auto flex min-w-0 items-end gap-0.5">
              {showWriteBadge ? (
                <span className="inline-flex h-[37px] shrink-0 items-center">
                  <span
                    title={props.workspace.readOnlyReason ?? write.label}
                    className={
                      write.tone === "pending"
                        ? "rounded-md border border-border bg-zinc-800 px-2 py-0.5 text-xs font-medium text-muted-foreground"
                        : "rounded-md border border-amber-500/80 bg-amber-950 px-2 py-0.5 text-xs font-medium text-amber-200"
                    }
                  >
                    {write.label}
                  </span>
                </span>
              ) : null}
              {props.publish ? (
                <ConversationPublishActions publish={props.publish} />
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

export function ConversationPublishActions(props: {
  publish: ConversationPublishChrome
}) {
  const { commitPush, pullRequest } = props.publish
  return (
    <div className="mb-px flex h-[37px] shrink-0 items-center gap-1">
      <Button
        variant="ghost"
        size="default"
        isDisabled={!commitPush.enabled || commitPush.pending}
        isPending={commitPush.pending}
        onPress={commitPush.onPress}
        className="h-8 px-2 text-xs"
      >
        {commitPush.pending ? "Pushing…" : "Commit+Push"}
      </Button>
      {pullRequest.action === "show" && pullRequest.href ? (
        <AriaLink
          href={pullRequest.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          Show PR
        </AriaLink>
      ) : (
        <Button
          variant="ghost"
          size="default"
          isDisabled={pullRequest.pending}
          isPending={pullRequest.pending}
          onPress={pullRequest.onPress}
          className="h-8 px-2 text-xs"
        >
          {pullRequest.pending ? "Creating PR…" : "Create PR"}
        </Button>
      )}
    </div>
  )
}
