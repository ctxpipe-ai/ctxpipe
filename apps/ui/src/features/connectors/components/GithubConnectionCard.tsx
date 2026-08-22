"use client"

import { IconBrandGithub } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { toast } from "sonner"
import { AlertDialog } from "@/components/ui/AlertDialog"
import { Modal } from "@/components/ui/Modal"
import {
  githubConnectorKeys,
  githubInstallationIsLinked,
} from "@/features/connectors/queries/github-connector"
import { apiFetch, readApiJson } from "@/lib/api-result"
import { resolveConnectorHealth } from "../connectorHealth"
import { orgConnectionsKeys } from "../queries/org-connections"
import {
  ConnectorListItem,
  ConnectorRemoveMenu,
  connectorDash,
} from "./ConnectorListItem"

type GithubConnectionCardProps = {
  orgSlug: string
  connectionId: string
}

async function deleteGithubConnector(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const qs = new URLSearchParams({ connectionId })
  const res = await apiFetch(
    `/${orgSlug}/api/v1/github/installation?${qs.toString()}`,
    { method: "DELETE", credentials: "include" },
  )
  await readApiJson(res, { message: "Failed to remove connector" })
}

export function GithubConnectionCard({
  orgSlug,
  connectionId,
}: GithubConnectionCardProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [removeOpen, setRemoveOpen] = useState(false)
  const {
    data: installation,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: githubConnectorKeys.installation(orgSlug, connectionId),
    queryFn: async () => {
      const qs = new URLSearchParams({ connectionId })
      const res = await apiFetch(
        `/${orgSlug}/api/v1/github/installation?${qs.toString()}`,
        { credentials: "include" },
      )
      return readApiJson<{
        id: string
        installationId: number | null
        accountSlug: string | null
        ingestionRepositoryCount: number
      } | null>(res, {
        message: "Failed to load GitHub connection",
      })
    },
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
      setRemoveOpen(false)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const linked = githubInstallationIsLinked(installation)
  const health = resolveConnectorHealth({
    statusError: isError,
    checking: isPending,
    connected: linked,
  })

  return (
    <>
      <ConnectorListItem
        id={`connector-github-${connectionId}`}
        name="GitHub"
        icon={
          <IconBrandGithub className="size-5 text-foreground" aria-hidden />
        }
        health={health}
        menu={
          <ConnectorRemoveMenu
            ariaLabel="GitHub connector actions"
            onRemove={() => setRemoveOpen(true)}
          />
        }
        workspace={connectorDash(installation?.accountSlug)}
        scope="GitHub App"
        syncRepository="—"
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
                      to: "/$orgSlug/repositories/github/setup",
                      params: { orgSlug },
                      search: { returnTo: "connectors" },
                    })
                    return
                  }
                  void navigate({
                    to: "/$orgSlug/repositories/github/setup",
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

      <Modal isOpen={removeOpen} onOpenChange={setRemoveOpen} isDismissable>
        <AlertDialog
          title="Remove GitHub connector?"
          variant="destructive"
          actionLabel="Remove connector"
          cancelLabel="Cancel"
          onAction={() => removeMutation.mutate()}
        >
          This unlinks the GitHub App installation from ctxpipe. Existing
          repositories stay in ctxpipe, but they will no longer be managed by
          this connector. The GitHub App remains installed in GitHub.
        </AlertDialog>
      </Modal>
    </>
  )
}
