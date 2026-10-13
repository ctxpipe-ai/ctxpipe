import { Link } from "@/components/ui/Link"

/**
 * The last step of a connector setup, after an add that opened pull
 * requests: the sync of each Workspace starts after its merge.
 */
export function PullRequestsToMerge(props: { urls: string[] }) {
  return (
    <>
      <p className="mt-2 text-sm text-muted-foreground">
        Merge the pull request to start the sync.
      </p>
      <ul className="mt-2 space-y-1 text-sm">
        {props.urls.map((url) => (
          <li key={url}>
            <Link href={url} target="_blank" rel="noreferrer">
              {url
                .replace(/^https:\/\/github\.com\//, "")
                .replace("/pull/", "#")}
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}
