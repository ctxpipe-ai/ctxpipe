import { Button } from "@/components/ui/Button"
import { PullRequestsToMerge } from "@/features/workspace-sources/PullRequestsToMerge"
import type { OpenedPullRequest } from "@/features/workspace-sources/useAddToWorkspaces"

type SetupCompleteStepProps = {
  orgSlug: string
  onClose: () => void
  /** The pull requests that the add opened. */
  pullRequests?: OpenedPullRequest[]
}

export function SetupCompleteStep({
  orgSlug,
  onClose,
  pullRequests = [],
}: SetupCompleteStepProps) {
  return (
    <div className="space-y-4">
      {pullRequests.length ? (
        <PullRequestsToMerge orgSlug={orgSlug} pullRequests={pullRequests} />
      ) : (
        <div>
          <h3 className="text-base font-medium text-foreground">
            Confluence is connected
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Confluence is linked and the Forge app is installed. Add Confluence
            to a Workspace from the connector card, or change the spaces of a
            Workspace in its settings.
          </p>
        </div>
      )}
      <Button variant="secondary" className="rounded-md" onPress={onClose}>
        Close
      </Button>
    </div>
  )
}
