"use client"

import { useQuery } from "@tanstack/react-query"
import { ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { Spinner } from "@/components/ui/spinner"
import {
  atlassianConnectorKeys,
  fetchAtlassianConnectorStatus,
} from "../../../queries/atlassian-connector"

type MergeConfigStepProps = {
  orgSlug: string
  atlassianConnectionId?: string
}

export function MergeConfigStep({
  orgSlug,
  atlassianConnectionId,
}: MergeConfigStepProps) {
  const { data: status, isPending } = useQuery({
    queryKey: atlassianConnectorKeys.status(orgSlug, atlassianConnectionId),
    queryFn: () =>
      fetchAtlassianConnectorStatus(orgSlug, atlassianConnectionId),
    enabled: true,
    refetchInterval: (query) => {
      const d = query.state.data
      if (d?.setupPhase === "live") return false
      if (d?.setupPhase === "initial_sync") return 2000
      if (d?.pendingConfigPrCreating || !d?.pendingConfigPullUrl) return 2000
      return false
    },
  })

  const creating = status?.pendingConfigPrCreating ?? false

  const syncingAfterMerge = status?.setupPhase === "initial_sync"

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-foreground">
          {syncingAfterMerge
            ? "Syncing content"
            : "Approve configuration in GitHub"}
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {syncingAfterMerge ? (
            <>
              Your configuration is merged. We are syncing Confluence pages to
              Git based on{" "}
              <code className="rounded-none bg-muted px-1 py-0.5 text-xs">
                confluence/config.yaml
              </code>
              . This usually completes within a minute or two.
            </>
          ) : (
            <>
              Sync scope is stored as infrastructure-as-code in{" "}
              <code className="rounded-none bg-muted px-1 py-0.5 text-xs">
                confluence/config.yaml
              </code>{" "}
              on your repository&apos;s default branch. Open the pull request,
              review the proposal with your team, and merge it. After merge,
              Confluence content sync runs automatically from that file.
            </>
          )}
        </p>
      </div>

      {isPending || creating || syncingAfterMerge ? (
        <div className="space-y-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <Spinner className="size-4" />
            {creating
              ? "Creating pull request…"
              : syncingAfterMerge
                ? "Syncing Confluence content to Git…"
                : "Checking connector status…"}
          </div>
          {creating ? (
            <p>
              This can take a minute while ctxpipe starts the sync worker and
              prepares the repository.
            </p>
          ) : null}
        </div>
      ) : null}

      {!syncingAfterMerge && status?.pendingConfigPullUrl ? (
        <Button
          variant="primary"
          className="rounded-none"
          onPress={() =>
            window.open(
              status.pendingConfigPullUrl ?? "",
              "_blank",
              "noopener,noreferrer",
            )
          }
        >
          <ExternalLink className="mr-2 size-4" aria-hidden />
          Open pull request
        </Button>
      ) : null}

      {!creating &&
      !syncingAfterMerge &&
      status?.setupPhase === "awaiting_merge" &&
      !status.pendingConfigPullUrl ? (
        <p className="text-sm text-muted-foreground">
          Pull request creation failed. Return to the previous step and save the
          scope again. If it continues to fail, check that the GitHub App can
          write to the repository.
        </p>
      ) : null}
    </div>
  )
}
