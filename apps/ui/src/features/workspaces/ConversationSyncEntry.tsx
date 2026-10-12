import { IconCloudUpload, IconExternalLink } from "@tabler/icons-react"
import { Link as AriaLink } from "react-aria-components"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import type { ConversationSync } from "./types"

/** One Sync in the thread: the files it pushed and a link to the branch. */
export function ConversationSyncEntry(props: { sync: ConversationSync }) {
  const { sync } = props
  const files = `${sync.files} ${sync.files === 1 ? "file" : "files"}`
  return (
    <section
      aria-label={`Synced ${files} to ${sync.branch}`}
      className="flex w-full min-w-0 items-center gap-2 rounded-md bg-foreground/[0.03] px-4 py-2 text-sm"
    >
      <IconCloudUpload
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="shrink-0 text-muted-foreground">Synced {files} to</span>
      <AriaLink
        href={sync.treeUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${sync.branch} on GitHub (opens in a new tab)`}
        className={cn(
          focusVisibleClassName,
          "group inline-flex min-w-0 items-center gap-1.5 rounded-md font-mono text-xs text-foreground transition-colors hover:text-teal-400",
        )}
      >
        <span className="truncate">{sync.branch}</span>
        <IconExternalLink
          className="size-3.5 shrink-0 opacity-0 transition-opacity group-data-[hovered]:opacity-100 group-data-[focus-visible]:opacity-100"
          aria-hidden
        />
      </AriaLink>
    </section>
  )
}
