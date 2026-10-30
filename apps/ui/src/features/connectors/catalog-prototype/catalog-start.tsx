/**
 * PROTOTYPE, throwaway. Lives only on branch prototype/connector-catalog.
 * Do not merge into main.
 *
 * Question (CTX-1078): what should "Add connection" look like with 10+
 * connectors? A variant tile must open the same setup as today's
 * `Add…ConnectorButton`. This hook runs the same first request that each
 * button runs, then calls the same route handler (`CatalogStartHandlers`).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"

import { registerAtlassianInstallIntent } from "../queries/atlassian-connector"
import {
  createLinearDraft,
  fetchLinearOauthApp,
} from "../queries/linear-connector"
import { createDraftNotionConnection } from "../queries/notion-connector"
import { orgConnectionsKeys } from "../queries/org-connections"
import { startPagerdutySetup } from "../queries/pagerduty-connector"
import { useGithubConnectFlow } from "../useGithubConnectFlow"
import type { CatalogId, StartableId } from "./catalog-data"

/** The route's start of each entry: the `onStart` of each catalog button. */
export type CatalogStartHandlers = {
  /** The self-hosted GitHub wizard; the managed App path navigates. */
  github: () => void
  confluence: (args: { connectionId: string }) => void
  slack: () => void
  linear: (connectionId?: string) => void
  notion: (args: { connectionId: string }) => void
  pagerduty: (args: { connectionId?: string }) => void
  buildkite: () => void
  plain: () => void
}

export function useCatalogStart(input: {
  orgSlug: string
  start: CatalogStartHandlers
  onFlowStarted: () => void
}) {
  const { orgSlug, start } = input
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const invalidateList = () =>
    queryClient.invalidateQueries({
      queryKey: orgConnectionsKeys.list(orgSlug),
    })

  // As in AddGithubConnectorButton.
  const goToSharedSetup = () =>
    navigate({
      to: "/$orgSlug/github/setup",
      params: { orgSlug },
      search: { returnTo: "connectors" },
    })
  const github = useGithubConnectFlow({
    orgSlug,
    onAlreadyInstalled: () => {
      input.onFlowStarted()
      void goToSharedSetup()
    },
    onRegistered: () => void goToSharedSetup(),
    onFlowStarted: input.onFlowStarted,
    onRegistrationFailed: (message) => toast.error(message),
    delegateSelfHostedWizard: start.github,
  })

  const request = useMutation({
    mutationFn: async (id: StartableId) => {
      switch (id) {
        case "confluence": {
          const data = await registerAtlassianInstallIntent(orgSlug)
          await invalidateList()
          return () => start.confluence({ connectionId: data.id })
        }
        case "linear": {
          const oauth = await fetchLinearOauthApp(orgSlug)
          if (oauth.globalLinearOauthConfigured) return () => start.linear()
          const draft = await createLinearDraft(orgSlug)
          return () => start.linear(draft.connectionId)
        }
        case "notion": {
          const draft = await createDraftNotionConnection(orgSlug)
          await invalidateList()
          return () => start.notion({ connectionId: draft.id })
        }
        case "pagerduty": {
          const data = await startPagerdutySetup(orgSlug)
          if (data.connectionId) await invalidateList()
          return () =>
            start.pagerduty({ connectionId: data.connectionId ?? undefined })
        }
        default:
          return () => {}
      }
    },
    onSuccess: (open) => open(),
    onError: (error: Error) => toast.error(error.message),
  })

  const run = (id: CatalogId) => {
    switch (id) {
      case "github":
        github.start("connect")
        return
      case "slack":
        start.slack()
        return
      case "buildkite":
        start.buildkite()
        return
      case "plain":
        start.plain()
        return
      case "confluence":
      case "linear":
      case "notion":
      case "pagerduty":
        request.mutate(id)
        return
      default:
        // Zendesk on self-host: its setup is on an unmerged branch.
        toast.info("Prototype: the Zendesk setup is not on main yet.")
    }
  }

  const pendingId: CatalogId | null =
    github.isPending || github.isSyncing
      ? "github"
      : request.isPending
        ? (request.variables ?? null)
        : null

  return { run, pendingId, githubModal: github.SelfHostedWizardModal }
}

/** "Ask for it" on a coming-soon entry. A stub: nothing is sent. */
export function askForIt(name: string) {
  toast.success(`Thanks. We noted that you want ${name}.`)
}
