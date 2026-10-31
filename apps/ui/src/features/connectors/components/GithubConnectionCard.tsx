"use client"

import { IconBrandGithub } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"

import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
  githubInstallationIsLinked,
} from "@/features/connectors/queries/github-connector"
import { ConnectorUsedIn } from "@/features/workspace-sources/ConnectorUsedIn"
import { client } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"

import { resolveConnectorHealth } from "../connectorHealth"
import { orgConnectionsKeys } from "../queries/org-connections"
import { ConnectorListItem, connectorDash } from "./ConnectorListItem"

type GithubConnectionCardProps = {
  orgSlug: string
  connectionId: string
  /** The catalog Fix marks the card for a moment. */
  marked?: boolean
}

async function deleteGithubConnector(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.github.installation.$delete({
    param: { orgSlug },
    query: { connectionId },
  })
  await readApiJson(res, { message: "Failed to remove connector" })
}

export function GithubConnectionCard({
  orgSlug,
  connectionId,
  marked,
}: GithubConnectionCardProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const {
    data: installation,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: githubConnectorKeys.installation(orgSlug, connectionId),
    queryFn: () => fetchGithubInstallationSummary(orgSlug, connectionId),
  })

  const removeMutation = useMutation({
    mutationFn: () => deleteGithubConnector(orgSlug, connectionId),
    onSuccess: async () => {
      toast.success("GitHub connector removed.")
      await queryClient.invalidateQueries({
        queryKey: githubConnectorKeys.installation(orgSlug, connectionId),
      })
      await queryClient.invalidateQueries({
        queryKey: githubConnectorKeys.allInstallationForOrg(orgSlug),
      })
      await queryClient.invalidateQueries({
        queryKey: ["github-installation-repos-preview", orgSlug],
      })
      await queryClient.invalidateQueries({
        queryKey: ["github-installation-setup", orgSlug],
      })
      await queryClient.invalidateQueries({
        queryKey: ["repositories", orgSlug],
      })
      await queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const linked = githubInstallationIsLinked(installation)
  const health = resolveConnectorHealth({
    statusError: isError,
    checking: isPending,
    connected: linked,
    draft: !linked,
  })

  return (
    <ConnectorListItem
      connectionId={connectionId}
      marked={marked}
      usedIn={
        <ConnectorUsedIn
          orgSlug={orgSlug}
          connectionId={connectionId}
          provider="github"
        />
      }
      name="GitHub"
      icon={<IconBrandGithub className="size-5 text-foreground" aria-hidden />}
      health={health}
      remove={{
        description:
          "This unlinks the GitHub App installation from ctxpipe. Existing repositories stay in ctxpipe, but they will no longer be managed by this connector. The GitHub App remains installed in GitHub.",
        onConfirm: () => removeMutation.mutate(),
      }}
      workspace={connectorDash(installation?.accountSlug)}
      actionLabel={
        isError
          ? "Retry"
          : isPending
            ? undefined
            : !linked
              ? "Complete GitHub install"
              : "Link to a workspace"
      }
      onAction={
        isError
          ? () => void refetch()
          : isPending
            ? undefined
            : () => {
                if (!linked) {
                  void navigate({
                    to: "/$orgSlug/github/setup",
                    params: { orgSlug },
                    search: { returnTo: "connectors" },
                  })
                  return
                }
                void navigate({
                  to: "/$orgSlug/github/setup",
                  params: { orgSlug },
                  search: { returnTo: "connectors" },
                })
              }
      }
    >
      {isError ? (
        <p className="text-sm text-muted-foreground">
          Status request failed. Retry, or open setup if this persists.
        </p>
      ) : null}
    </ConnectorListItem>
  )
}
