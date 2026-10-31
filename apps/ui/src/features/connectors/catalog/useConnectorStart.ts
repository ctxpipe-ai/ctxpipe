import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"

import { orgConnectionsKeys } from "../queries/org-connections"
import { useGithubConnectFlow } from "../useGithubConnectFlow"
import type {
  AvailableConnectorEntry,
  ConnectionType,
  SetupTarget,
} from "./registry"

/**
 * The Connectors page opens each setup dialog: one opener for each
 * connector. The GitHub opener is the self-hosted wizard; the hosted GitHub
 * App install starts from the catalog.
 */
export type ConnectorSetupOpeners = Record<
  ConnectionType,
  (target: SetupTarget) => void
>

/**
 * Starts the setup of a catalog entry: the first request of the entry, if
 * it has one, then the page opener. The catalog closes before the setup
 * opens, so that the setup dialog is the only dialog.
 */
export function useConnectorStart(input: {
  orgSlug: string
  openSetup: ConnectorSetupOpeners
  closeCatalog: () => void
}) {
  const { orgSlug, openSetup, closeCatalog } = input
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const open = (id: ConnectionType, target: SetupTarget) => {
    closeCatalog()
    openSetup[id](target)
  }

  const goToGithubSetup = () =>
    navigate({
      to: "/$orgSlug/github/setup",
      params: { orgSlug },
      search: { returnTo: "connectors" },
    })
  // The catalog stays open while the GitHub install popup runs: the flow
  // watches the popup from this component.
  const github = useGithubConnectFlow({
    orgSlug,
    onAlreadyInstalled: () => void goToGithubSetup(),
    onRegistered: () => void goToGithubSetup(),
    onRegistrationFailed: (message) => toast.error(message),
    delegateSelfHostedWizard: () => open("github", {}),
  })

  const prepare = useMutation({
    mutationFn: async (entry: AvailableConnectorEntry) => {
      const target = (await entry.prepare?.(orgSlug)) ?? {}
      if (target.connectionId) {
        await queryClient.invalidateQueries({
          queryKey: orgConnectionsKeys.list(orgSlug),
        })
      }
      return target
    },
    onSuccess: (target, entry) => open(entry.id, target),
    onError: (error: Error) => toast.error(error.message),
  })

  const start = (entry: AvailableConnectorEntry) => {
    if (entry.id === "github") github.start("connect")
    else if (entry.prepare) prepare.mutate(entry)
    else open(entry.id, {})
  }

  const pendingId: ConnectionType | null =
    github.isPending || github.isSyncing
      ? "github"
      : prepare.isPending
        ? (prepare.variables?.id ?? null)
        : null

  return { start, pendingId }
}
