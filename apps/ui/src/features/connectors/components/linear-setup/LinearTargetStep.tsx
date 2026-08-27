"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { workspaceListOptions } from "@/features/workspaces/queries"
import type { Workspace } from "@/features/workspaces/types"
import {
  ConnectorWorkspaceDestinationPicker,
  destinationFromWorkspace,
  workspaceMatchingGitUrl,
} from "../ConnectorWorkspaceDestinationPicker"
import {
  fetchLinearConnectorConfig,
  linearConnectorKeys,
  patchLinearConnectorConfig,
} from "../../queries/linear-connector"

type LinearTargetStepProps = {
  orgSlug: string
  connectionId: string
  onSaved: () => Promise<unknown>
  onBack?: () => void
}

export function LinearTargetStep({
  orgSlug,
  connectionId,
  onSaved,
  onBack,
}: LinearTargetStepProps) {
  const queryClient = useQueryClient()
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(
    null,
  )
  const { data: workspaces } = useQuery(workspaceListOptions(orgSlug))
  const { data: config } = useQuery({
    queryKey: linearConnectorKeys.config(orgSlug, connectionId),
    queryFn: () => fetchLinearConnectorConfig(orgSlug, connectionId),
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
      return patchLinearConnectorConfig(orgSlug, connectionId, {
        syncTarget: {
          repositoryName: destination.repositoryName,
          gitUrl: destination.gitUrl,
          githubConnectionId: destination.githubConnectionId ?? undefined,
          branch: destination.branch,
          enabled: true,
        },
      })
    },
    onSuccess: async () => {
      toast.success("Linear workspace destination saved.")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: linearConnectorKeys.status(orgSlug, connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: linearConnectorKeys.config(orgSlug, connectionId),
        }),
        onSaved(),
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
          Linear files are written to that workspace repository. Connections
          stay git-native.
        </p>
      </div>
      <ConnectorWorkspaceDestinationPicker
        orgSlug={orgSlug}
        selectedWorkspaceId={configuredWorkspace?.id ?? null}
        onSelect={setSelectedWorkspace}
      />
      <div className="flex items-center justify-between border-t border-border pt-4">
        {onBack ? (
          <Button variant="secondary" className="rounded-md" onPress={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
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
    </div>
  )
}
