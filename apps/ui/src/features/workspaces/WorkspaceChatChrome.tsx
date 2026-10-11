import {
  IconCloudUpload,
  IconExternalLink,
  IconGitPullRequest,
} from "@tabler/icons-react"
import type { ReactElement, ReactNode } from "react"
import { Link as AriaLink } from "react-aria-components"
import { OverlayNavMenuButton } from "@/components/OverlayNavButton"
import { Button } from "@/components/ui/Button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import type { Workspace } from "./types"
import {
  workspaceChromeCardClassName,
  workspaceChromeOuterClassName,
  workspaceChromeOuterFlushClassName,
  workspaceChromeTabClassName,
  workspaceChromeTabIdleClassName,
  workspaceChromeTabStripClassName,
} from "./workspaceChrome"
import { writeStatusLabel } from "./writeStatusLabel"

export type ConversationPublishChrome = {
  commitPush: {
    visible: boolean
    enabled: boolean
    pending: boolean
    onPress: () => void
  }
  pullRequest: {
    visible: boolean
    action: "create" | "show"
    pending: boolean
    href?: string | null
    onPress: () => void
  }
}

/** Header tooltip on a non-focusable `trigger` element (a span). */
function ChromeTooltip(props: {
  trigger: ReactElement
  content: ReactNode
  children: ReactNode
}) {
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger render={props.trigger}>{props.children}</TooltipTrigger>
        <TooltipContent
          side="bottom"
          sideOffset={6}
          className="border-0 bg-zinc-800 text-zinc-100 shadow-md"
          arrowClassName="bg-zinc-800 fill-zinc-800"
        >
          {props.content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
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
  const write = writeStatusLabel(
    props.workspace.writeStatus,
    props.workspace.readOnlyReason,
  )
  const publishHasActions = Boolean(
    props.publish &&
      (props.publish.commitPush.visible || props.publish.pullRequest.visible),
  )
  const showWriteBadge =
    !props.publish && (write.tone === "read_only" || write.tone === "pending")
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
          <div
            className={cn(
              workspaceChromeTabClassName,
              "max-w-[min(100%,24rem)]",
            )}
          >
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
          {props.headerExtra || showWriteBadge || publishHasActions ? (
            <div className="ml-auto flex min-w-0 items-end gap-0.5">
              {showWriteBadge ? (
                <span className="inline-flex h-[37px] shrink-0 items-center">
                  <ChromeTooltip
                    trigger={
                      <span
                        className={
                          write.tone === "pending"
                            ? "rounded-md border border-border bg-zinc-800 px-2 py-0.5 text-xs font-medium text-muted-foreground"
                            : "rounded-md border border-amber-500/80 bg-amber-950 px-2 py-0.5 text-xs font-medium text-amber-200"
                        }
                      />
                    }
                    content={write.description}
                  >
                    {write.label}
                    {/* The popup shows on hover only; keep the text for assistive tech. */}
                    <span className="sr-only">: {write.description}</span>
                  </ChromeTooltip>
                </span>
              ) : null}
              {publishHasActions && props.publish ? (
                <ConversationPublishActions
                  publish={props.publish}
                  className={workspaceChromeTabStripClassName}
                />
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

/**
 * Sync and Create PR use the pane triggers' idle tab style. The class wins
 * over the ghost variant, so it must also set the disabled and pending text.
 */
const publishButtonClassName = (state: {
  isDisabled: boolean
  isPending: boolean
}) =>
  cn(
    workspaceChromeTabIdleClassName,
    "gap-1.5 text-xs font-normal pressed:bg-teal-900/30",
    state.isDisabled &&
      "cursor-default hover:bg-transparent hover:text-zinc-400",
    state.isDisabled && !state.isPending && "opacity-50",
    state.isPending && "text-transparent hover:text-transparent",
  )

/**
 * Sync (commit and push), Create PR, and Show PR. They look the same as the
 * pane triggers. `className` lets the tools pane show the actions only when
 * the conversation column is hidden, so the page shows each action once.
 */
export function ConversationPublishActions(props: {
  publish: ConversationPublishChrome
  className?: string
}) {
  const { commitPush, pullRequest } = props.publish
  const showCommit = commitPush.visible
  const showPrLink = pullRequest.action === "show" && Boolean(pullRequest.href)
  const showCreatePr = pullRequest.visible && pullRequest.action === "create"
  if (!showCommit && !showPrLink && !showCreatePr) return null
  return (
    <div className={cn("flex shrink-0 items-end gap-0.5", props.className)}>
      {showCommit ? (
        // A span trigger: the tooltip shows on hover also while Sync is disabled.
        <ChromeTooltip
          trigger={<span className="inline-flex" />}
          content="Commit and push your changes to the conversation branch"
        >
          <Button
            variant="ghost"
            isDisabled={!commitPush.enabled || commitPush.pending}
            isPending={commitPush.pending}
            onPress={commitPush.onPress}
            aria-label={
              commitPush.pending
                ? "Syncing: commit and push in progress"
                : "Sync: commit and push your changes"
            }
            className={publishButtonClassName}
          >
            <IconCloudUpload className="size-4" stroke={1.6} aria-hidden />
            {commitPush.pending ? "Syncing…" : "Sync"}
          </Button>
        </ChromeTooltip>
      ) : null}
      {showPrLink ? (
        <AriaLink
          href={pullRequest.href ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Show PR (opens in a new tab)"
          className={cn(
            workspaceChromeTabIdleClassName,
            focusVisibleClassName,
            "relative gap-1.5 pr-4 text-xs font-normal",
          )}
        >
          <IconGitPullRequest className="size-4" stroke={1.6} aria-hidden />
          Show PR
          <IconExternalLink
            data-external-badge
            className="absolute top-1 right-1 size-2.5"
            stroke={2}
            aria-hidden
          />
        </AriaLink>
      ) : showCreatePr ? (
        <Button
          variant="ghost"
          isDisabled={pullRequest.pending}
          isPending={pullRequest.pending}
          onPress={pullRequest.onPress}
          className={publishButtonClassName}
        >
          <IconGitPullRequest className="size-4" stroke={1.6} aria-hidden />
          {pullRequest.pending ? "Creating PR…" : "Create PR"}
        </Button>
      ) : null}
    </div>
  )
}
