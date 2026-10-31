import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useRef } from "react"
import { toast } from "sonner"

import { orgConnectionsKeys } from "../queries/org-connections"
import { useGithubConnectFlow } from "../useGithubConnectFlow"
import {
  type AvailableConnectorEntry,
  CONNECTOR_REGISTRY,
  type ConnectionType,
  type ConnectorStartContext,
  type SetupRequest,
} from "./registry"

/**
 * Runs the start of a catalog entry (`ConnectorEntry.start`). When the start
 * gives a setup, the catalog closes before the page opens it, so that the
 * setup dialog is the only dialog.
 */
export function useConnectorStart(input: {
  orgSlug: string
  onOpenSetup: (setup: SetupRequest) => void
  closeCatalog: () => void
}) {
  const { orgSlug, onOpenSetup, closeCatalog } = input
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const goToGithubSetup = () =>
    navigate({
      to: "/$orgSlug/github/setup",
      params: { orgSlug },
      search: { returnTo: "connectors" },
    })
  // The flow watches the install popup from this component. It calls the
  // delegate in place of its own wizard when there is no hosted App.
  const selfHosted = useRef(false)
  const github = useGithubConnectFlow({
    orgSlug,
    onAlreadyInstalled: () => void goToGithubSetup(),
    onRegistered: () => void goToGithubSetup(),
    onRegistrationFailed: (message) => toast.error(message),
    delegateSelfHostedWizard: () => {
      selfHosted.current = true
    },
  })
  const context: ConnectorStartContext = {
    orgSlug,
    githubApp: {
      install: () => {
        selfHosted.current = false
        github.start("connect")
        return selfHosted.current
      },
      isBusy: github.isPending || github.isSyncing,
    },
  }

  const startEntry = useMutation({
    mutationFn: async (entry: AvailableConnectorEntry) => {
      const target = await entry.start(context)
      if (target?.connectionId) {
        await queryClient.invalidateQueries({
          queryKey: orgConnectionsKeys.list(orgSlug),
        })
      }
      return target
    },
    onSuccess: (target, entry) => {
      if (!target) return
      closeCatalog()
      onOpenSetup({ ...target, type: entry.id })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const pendingId: ConnectionType | null = startEntry.isPending
    ? (startEntry.variables?.id ?? null)
    : (CONNECTOR_REGISTRY.find(
        (entry): entry is AvailableConnectorEntry =>
          entry.availability === "available" &&
          Boolean(entry.isBusy?.(context)),
      )?.id ?? null)

  return { start: startEntry.mutate, pendingId }
}
