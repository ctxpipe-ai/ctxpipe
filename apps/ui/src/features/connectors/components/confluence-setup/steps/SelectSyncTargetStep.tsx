import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { workspaceListOptions } from "@/features/workspaces/queries"
import type { Workspace } from "@/features/workspaces/types"
import {
  atlassianConnectorKeys,
  fetchAtlassianConnectorConfig,
  patchAtlassianConnectorConfig,
} from "../../../queries/atlassian-connector"
import {
  ConnectorWorkspaceDestinationPicker,
  destinationFromWorkspace,
  workspaceMatchingGitUrl,
} from "../../ConnectorWorkspaceDestinationPicker"

type SelectSyncTargetStepProps = {
  orgSlug: string
  atlassianConnectionId?: string
}

export function SelectSyncTargetStep({
  orgSlug,
  atlassianConnectionId,
}: SelectSyncTargetStepProps) {
  const queryClient = useQueryClient()
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(
    null,
  )
  const { data: workspaces } = useQuery(workspaceListOptions(orgSlug))
  const { data: config } = useQuery({
    queryKey: atlassianConnectorKeys.config(orgSlug, atlassianConnectionId),
    queryFn: () =>
      fetchAtlassianConnectorConfig(orgSlug, atlassianConnectionId),
    throwOnError: false,
  })
  const configuredWorkspace =
    selectedWorkspace ??
    workspaceMatchingGitUrl(
      workspaces?.items ?? [],
      config?.syncTarget
        ? `https://github.com/${config.syncTarget.repositoryName}.git`
        : null,
    )
  const destination = configuredWorkspace
    ? destinationFromWorkspace(configuredWorkspace)
    : null

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!destination) throw new Error("Select a workspace")
      return patchAtlassianConnectorConfig(
        orgSlug,
        {
          syncTarget: {
            repositoryName: destination.repositoryName,
            gitUrl: destination.gitUrl,
            branch: destination.branch,
            enabled: true,
          },
        },
        atlassianConnectionId,
      )
    },
    onSuccess: async (data) => {
      toast.success(
        data.configPrEnqueued
          ? "Workspace saved. A pull request for confluence/config.yaml is being created."
          : "Workspace saved.",
      )
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: atlassianConnectorKeys.status(
            orgSlug,
            atlassianConnectionId,
          ),
        }),
        queryClient.invalidateQueries({
          queryKey: atlassianConnectorKeys.config(
            orgSlug,
            atlassianConnectionId,
          ),
        }),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Select a workspace
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Confluence pages are written to that workspace repository.
        </p>
      </div>
      <ConnectorWorkspaceDestinationPicker
        orgSlug={orgSlug}
        selectedWorkspaceId={configuredWorkspace?.id ?? null}
        onSelect={setSelectedWorkspace}
      />
      <Button
        variant="primary"
        className="rounded-md"
        isPending={saveMutation.isPending}
        isDisabled={!destination}
        onPress={() => saveMutation.mutate()}
      >
        Save workspace
      </Button>
    </div>
  )
}
