import { IconExternalLink } from "@tabler/icons-react"
import type { ReactNode } from "react"

/**
 * The last step of a connector setup when the save opened source pull
 * requests: the change applies after each merge. Every setup dialog shows
 * this block, so the step looks the same for each connector.
 */
export function PullRequestsToMerge(props: {
  urls: string[]
  /** Replaces the default sentence, for a provider-specific note. */
  detail?: ReactNode
}) {
  return (
    <div>
      <h3 className="text-base font-medium text-foreground">
        Merge the pull request
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        {props.detail ?? "The source change applies after the merge."}
      </p>
      <ul className="mt-2 space-y-1 text-sm">
        {props.urls.map((url) => (
          <li key={url}>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-teal-400 hover:text-teal-300"
            >
              {url
                .replace(/^https:\/\/github\.com\//, "")
                .replace("/pull/", "#")}
              <IconExternalLink className="size-3.5" aria-hidden />
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
