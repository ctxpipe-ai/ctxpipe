"use client"

import { IconExternalLink } from "@tabler/icons-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Spinner } from "@/components/ui/spinner"
import {
  type LinearConnectorStatus,
  linearConnectorKeys,
  retryLinearSync,
} from "../../queries/linear-connector"

type LinearMergeStepProps = {
  orgSlug: string
  connectionId: string
  status: LinearConnectorStatus
  onRetry: () => Promise<unknown>
}

export function LinearMergeStep({
  orgSlug,
  connectionId,
  status,
  onRetry,
}: LinearMergeStepProps) {
  const queryClient = useQueryClient()
  const retryMutation = useMutation({
    mutationFn: () => retryLinearSync(orgSlug, connectionId),
    onSuccess: async () => {
      toast.success("Linear sync retry started.")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: linearConnectorKeys.status(orgSlug, connectionId),
        }),
        onRetry(),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const creating =
    status.pendingConfigPrCreating ||
    (status.setupPhase === "awaiting_merge" && !status.pendingConfigPullUrl)
  const syncing = status.setupPhase === "initial_sync"
  const failed = status.setupPhase === "sync_failed"

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          {failed
            ? "Linear sync failed"
            : syncing
              ? "Syncing Linear content"
              : "Approve configuration in GitHub"}
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {syncing ? (
            <>
              The configuration is merged. ctxpipe is mirroring Linear content
              to Git from{" "}
              <code className="rounded-none bg-muted px-1 py-0.5 text-xs">
                linear/config.yaml
              </code>
              .
            </>
          ) : (
            <>
              Review and merge the pull request for{" "}
              <code className="rounded-none bg-muted px-1 py-0.5 text-xs">
                linear/config.yaml
              </code>
              . The merged file controls scope; initial sync starts
              automatically.
            </>
          )}
        </p>
      </div>

      {failed ? (
        <InlineAlert variant="error" title="Content could not be synchronised">
          The configuration remains intact. Retry the content mirror without
          creating another pull request.
        </InlineAlert>
      ) : null}
      {creating || syncing ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          {creating
            ? "Creating configuration pull request..."
            : "Syncing Linear content to Git..."}
        </div>
      ) : null}
      {!failed && !syncing && status.pendingConfigPullUrl ? (
        <Button
          variant="primary"
          className="rounded-none"
          href={status.pendingConfigPullUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <IconExternalLink className="mr-2 size-4" aria-hidden />
          Open pull request
        </Button>
      ) : null}
      {failed ? (
        <Button
          variant="primary"
          className="rounded-none"
          isPending={retryMutation.isPending}
          onPress={() => retryMutation.mutate()}
        >
          Retry content sync
        </Button>
      ) : null}
    </div>
  )
}
