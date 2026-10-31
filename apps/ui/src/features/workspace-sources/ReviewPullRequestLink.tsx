import { IconExternalLink } from "@tabler/icons-react"

import { Link as TextLink } from "@/components/ui/Link"
import { cn } from "@/lib/utils"

/**
 * The teal link to a source pull request on GitHub, in a new tab. It is the
 * one action of a source change that waits for its merge (CTX-1060).
 */
export function ReviewPullRequestLink(props: {
  url: string
  label?: string
  className?: string
}) {
  const label = props.label ?? "Review pull request"
  return (
    <TextLink
      href={props.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`${label}. Opens GitHub in a new tab.`}
      className={cn("inline-flex items-center gap-1", props.className)}
    >
      {label}
      <IconExternalLink className="size-3 shrink-0" aria-hidden />
    </TextLink>
  )
}
