import { IconCloudUpload, IconExternalLink } from "@tabler/icons-react"
import { Link as AriaLink } from "react-aria-components"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import type { ConversationSync } from "./types"

function ExternalLink(props: { href: string; label: string; text: string }) {
  return (
    <AriaLink
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${props.label} (opens in a new tab)`}
      className={cn(
        focusVisibleClassName,
        "group inline-flex min-w-0 items-center gap-1.5 rounded-md text-foreground transition-colors hover:text-teal-400",
      )}
    >
      <span className="truncate">{props.text}</span>
      <IconExternalLink
        className="size-3.5 shrink-0 opacity-0 transition-opacity group-data-[hovered]:opacity-100 group-data-[focus-visible]:opacity-100"
        aria-hidden
      />
    </AriaLink>
  )
}

/** The words before the branch name, by what pushed. */
function pushedText(sync: ConversationSync): string {
  const files = `${sync.files} ${sync.files === 1 ? "file" : "files"}`
  if (sync.trigger === "sync") return `Synced ${files} to`
  if (sync.trigger === "agent") return `The agent pushed ${files} to`
  if (sync.trigger === "sweep") return `ctxpipe pushed ${files} to`
  return `Pushed ${files} to`
}

/**
 * One push of the conversation's commits in the thread: what pushed, the
 * number of files, and links to the branch and the pull request on GitHub.
 */
export function ConversationSyncEntry(props: { sync: ConversationSync }) {
  const { sync } = props
  const pr = sync.pullRequest
  const prText = pr ? `PR #${pr.number}` : ""
  const summary = [
    pushedText(sync),
    sync.branch,
    pr ? `${pr.opened ? "and opened" : "for"} ${prText}` : "",
  ]
    .filter(Boolean)
    .join(" ")
  return (
    <section
      aria-label={summary}
      className="flex w-full min-w-0 items-center gap-2 rounded-md bg-foreground/[0.03] px-4 py-2 text-sm"
    >
      <IconCloudUpload
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="shrink-0 text-muted-foreground">{pushedText(sync)}</span>
      <span className="flex min-w-0 font-mono text-xs">
        <ExternalLink
          href={sync.treeUrl}
          label={`${sync.branch} on GitHub`}
          text={sync.branch}
        />
      </span>
      {pr ? (
        <>
          <span className="shrink-0 text-muted-foreground">
            {pr.opened ? "and opened" : "for"}
          </span>
          <span className="shrink-0">
            <ExternalLink
              href={pr.url}
              label={`${prText} on GitHub`}
              text={prText}
            />
          </span>
        </>
      ) : null}
    </section>
  )
}
