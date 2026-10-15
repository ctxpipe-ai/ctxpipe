import {
  IconCloudUpload,
  IconGitBranch,
  IconGitPullRequest,
} from "@tabler/icons-react"
import { type ReactElement, type ReactNode, useRef } from "react"
import { Link as AriaLink } from "react-aria-components"
import { OverlayNavMenuButton } from "@/components/OverlayNavButton"
import { Button } from "@/components/ui/Button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip"
import { OnboardingHint } from "@/features/hints/OnboardingHint"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import { conversationCtaPlan } from "./conversationPublish"
import type { Workspace } from "./types"
import {
  workspaceChromeCardClassName,
  workspaceChromeOuterClassName,
  workspaceChromeOuterFlushClassName,
  workspaceChromeTabClassName,
  workspaceChromeTabStripClassName,
} from "./workspaceChrome"
import { writeStatusLabel } from "./writeStatusLabel"

export type ConversationCtaChrome = {
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
  href?: string | null
}

/** The branch name as a label with a git-branch icon. */
function BranchLabel(props: { branch: ConversationBranchChrome }) {
  const { shortName, href } = props.branch
  const labelClassName =
    "ml-2 inline-flex min-w-0 max-w-40 shrink items-center gap-1 rounded-md border border-border bg-zinc-800 px-1.5 py-0.5 font-mono text-xs font-normal text-muted-foreground"
  const content = (
    <>
      <IconGitBranch className="size-3 shrink-0" stroke={1.8} aria-hidden />
      <span className="truncate">{shortName}</span>
    </>
  )
  return (
    <span className={labelClassName}>
      {href ? (
        <AriaLink
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "inline-flex min-w-0 items-center gap-1 rounded-sm hover:text-teal-400",
            focusVisibleClassName,
          )}
        >
          {content}
        </AriaLink>
      ) : (
        content
      )}
    </span>
  )
}

/**
 * Conversation column chrome: card surface with the conversation name as an
 * active tab (conversation is one pane; files/graph/settings are the other).
 */
export function WorkspaceChatChrome(props: {
  workspace: Workspace
  /** Shows the one-time Create PR hint for a new user of this organization. */
  hintOrgSlug?: string
  title: ReactNode
  headerExtra?: ReactNode
  branch?: ConversationBranchChrome | null
  cta?: ConversationCtaChrome | null
  children: ReactNode
}) {
  const write = writeStatusLabel(
    props.workspace.writeStatus,
    props.workspace.readOnlyReason,
  )
  const ctaPlanNow = props.cta ? ctaPlan(props.cta) : null
  const ctaHasActions = Boolean(ctaPlanNow?.sync || ctaPlanNow?.pullRequest)
  const showWriteBadge = !props.cta && write.tone !== "writable"
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
              "max-w-[min(100%,24rem)] px-3",
            )}
          >
            {typeof props.title === "string" ? (
              <p className="min-w-0 truncate">{props.title}</p>
            ) : (
              props.title
            )}
            {props.branch ? <BranchLabel branch={props.branch} /> : null}
          </div>
          {props.headerExtra || showWriteBadge || ctaHasActions ? (
            <div className="ml-auto flex min-w-0 items-end gap-1">
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
              {ctaHasActions && props.cta ? (
                <ConversationCtaActions
                  cta={props.cta}
                  className={workspaceChromeTabStripClassName}
                  hintOrgSlug={props.hintOrgSlug}
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
 * The CTA button: Sync, Create PR and Show PR use the primary Button variant
 * (light face, dark text, hover and pressed states). This only shrinks it to
 * 27px, centered on the 37px trigger row (5px above and below).
 */
const ctaClassName =
  "my-[5px] h-[27px] gap-1.5 border-0 px-2.5 text-xs font-normal leading-none"

/** The CTA face is the `cta` token: the primary face, a little dimmer in dark mode. */
const ctaPrimaryClassName = "bg-cta hovered:bg-cta/90 pressed:bg-cta/80"

function ctaPlan(cta: ConversationCtaChrome) {
  const prExists =
    cta.pullRequest.action === "show" && Boolean(cta.pullRequest.href)
  const plan = conversationCtaPlan({
    syncVisible: cta.commitPush.visible,
    createPrVisible:
      cta.pullRequest.visible && cta.pullRequest.action === "create",
    createPrPending: cta.pullRequest.pending,
    prExists,
  })
  return plan
}

/**
 * Sync (commit and push), Create PR, and Show PR as CTA buttons. `className` lets the tools pane show the actions only when
 * the conversation column is hidden, so the page shows each action once.
 */
export function ConversationCtaActions(props: {
  cta: ConversationCtaChrome
  className?: string
  /** Only the conversation header passes it, so the hint shows once. */
  hintOrgSlug?: string
}) {
  const { commitPush, pullRequest } = props.cta
  const createPrRef = useRef<HTMLButtonElement>(null)
  const plan = ctaPlan(props.cta)
  const showCommit = plan.sync !== null
  const showPrLink = plan.pullRequest === "show"
  const showCreatePr = plan.pullRequest === "create"
  if (!showCommit && !showPrLink && !showCreatePr) return null
  return (
    <div className={cn("flex shrink-0 items-end gap-1", props.className)}>
      {showCommit ? (
        // A span trigger: the tooltip shows on hover also while Sync is disabled.
        <ChromeTooltip
          trigger={<span className="inline-flex" />}
          content="Commit and push your changes to the conversation branch"
        >
          <Button
            variant={plan.sync === "cta" ? "primary" : "ghost"}
            isDisabled={!commitPush.enabled || commitPush.pending}
            isPending={commitPush.pending}
            onPress={commitPush.onPress}
            aria-label={
              commitPush.pending
                ? "Syncing: commit and push in progress"
                : "Sync: commit and push your changes"
            }
            className={cn(
              ctaClassName,
              plan.sync === "cta" ? ctaPrimaryClassName : "border",
            )}
          >
            <IconCloudUpload className="size-4" stroke={1.6} aria-hidden />
            {commitPush.pending ? "Syncing…" : "Sync"}
          </Button>
        </ChromeTooltip>
      ) : null}
      {showPrLink ? (
        <Button
          variant={plan.sync === "cta" ? "ghost" : "primary"}
          href={pullRequest.href ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Show PR (opens in a new tab)"
          className={cn(
            ctaClassName,
            plan.sync === "cta" ? "border" : ctaPrimaryClassName,
          )}
        >
          <IconGitPullRequest className="size-4" stroke={1.6} aria-hidden />
          Show PR
        </Button>
      ) : showCreatePr ? (
        <>
          <Button
            ref={createPrRef}
            variant="primary"
            isDisabled={pullRequest.pending}
            isPending={pullRequest.pending}
            onPress={pullRequest.onPress}
            className={cn(ctaClassName, ctaPrimaryClassName)}
          >
            <IconGitPullRequest className="size-4" stroke={1.6} aria-hidden />
            {pullRequest.pending ? "Creating PR…" : "Create PR"}
          </Button>
          {props.hintOrgSlug ? (
            <OnboardingHint
              id="create-pr"
              orgSlug={props.hintOrgSlug}
              triggerRef={createPrRef}
            >
              Changes stay on this conversation's branch until you create a pull
              request.
            </OnboardingHint>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
