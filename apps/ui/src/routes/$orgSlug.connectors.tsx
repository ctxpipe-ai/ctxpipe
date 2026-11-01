import { IconPlus } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useState } from "react"

import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import {
  Skeleton,
  SkeletonRegion,
  useSkeletonHold,
} from "@/components/ui/Skeleton"
import {
  BuildkiteConnectionCard,
  BuildkiteSetupDialog,
  ConfluenceConnectionCard,
  ConnectorSetupDialog,
  ConnectorsEmptyState,
  GithubConnectionCard,
  LinearConnectionCard,
  LinearSetupWizard,
  NotionConnectionCard,
  NotionSetupDialog,
  PagerdutyConnectionCard,
  PagerdutySetupDialog,
  PlainConnectionCard,
  PlainSetupDialog,
  SlackConnectionCard,
} from "@/features/connectors"
import { sortOrgConnectionsForDisplay } from "@/features/connectors/catalog/catalog-state"
import { ConnectorCatalogDialog } from "@/features/connectors/catalog/ConnectorCatalogDialog"
import type {
  ConnectionType,
  SetupRequest,
} from "@/features/connectors/catalog/registry"
import { AtlassianAccountClaimModalContent } from "@/features/connectors/components/AtlassianAccountClaimModalContent"
import { ConnectorListSkeleton } from "@/features/connectors/components/ConnectorListItem"
import { ConnectorsOAuthErrorBanner } from "@/features/connectors/components/ConnectorsOAuthErrorBanner"
import { GithubSelfHostedWizardModal } from "@/features/connectors/components/GithubSelfHostedWizardModal"
import { SlackSetupDialog } from "@/features/connectors/components/SlackSetupDialog"
import { scrollToConnection } from "@/features/connectors/connectionAnchor"
import { atlassianConnectorKeys } from "@/features/connectors/queries/atlassian-connector"
import {
  orgConnectionsKeys,
  orgConnectionsOptions,
} from "@/features/connectors/queries/org-connections"
import { OrgOutletError } from "@/features/org/OrgOutletError"
import { FormatUpgradeWorkspacesNotice } from "@/features/workspace-upgrades/FormatUpgradeWorkspacesNotice"
import { useWorkspaceFormatGate } from "@/features/workspace-upgrades/use-workspace-format-gate"
import { workspaceListOptions } from "@/features/workspaces/queries"
import { client } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"
import { oauthErrorMessage } from "@/lib/atlassian-oauth-messages"
import { useSession } from "@/lib/auth-client"
import { useGithubConnectorBootstrap } from "@/lib/useGithubConnectorBootstrap"

export const Route = createFileRoute("/$orgSlug/connectors")({
  errorComponent: ({ error, reset }) => (
    <OrgOutletError
      title="Could not load connectors"
      error={error}
      reset={reset}
    />
  ),
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
    error_description:
      typeof search.error_description === "string"
        ? search.error_description
        : undefined,
    pendingAccountClaim:
      typeof search.pendingAccountClaim === "string"
        ? search.pendingAccountClaim
        : undefined,
    notionConnectionId:
      typeof search.notionConnectionId === "string"
        ? search.notionConnectionId
        : undefined,
    // Optional, so links to this page need not name it: only the Atlassian
    // account-link return path sets it.
    ...(typeof search.atlassianConnectionId === "string" && {
      atlassianConnectionId: search.atlassianConnectionId,
    }),
  }),
  component: ConnectorsPage,
})

/** One skeleton region, so the session skeleton hands over to the list skeleton. */
function ConnectorsPage() {
  return (
    <SkeletonRegion>
      <ConnectorsPageGate />
    </SkeletonRegion>
  )
}

function ConnectorsPageGate() {
  const { data: session, isPending: sessionPending } = useSession()
  const { orgSlug } = Route.useParams()

  if (sessionPending) {
    return (
      <main className="mx-auto box-border flex min-h-full w-full max-w-2xl flex-col p-8 text-foreground">
        <ConnectorsHeader actions={<Skeleton className="size-9" />} />
        <section className="mt-12 flex min-h-0 flex-col border-t border-white/[0.06]">
          <ConnectorListSkeleton />
        </section>
      </main>
    )
  }

  if (!session) return <Navigate to="/.auth/sign-in" replace />

  return <ConnectorsPageContent orgSlug={orgSlug} />
}

/**
 * The setup dialog that is open, and what it opens on. The catalog and the
 * cards open it; one setup is open at a time. A closed setup keeps its
 * connection, so that its dialog does not change while it closes.
 */
type PageSetup = SetupRequest & {
  isOpen: boolean
  /** Buildkite: replace the webhook. */
  replaceWebhook?: boolean
  /** Plain: save a new key for a revoked connection. */
  reconnect?: boolean
}

export function ConnectorsPageContent({ orgSlug }: { orgSlug: string }) {
  const navigate = useNavigate()
  const search = Route.useSearch()
  const queryClient = useQueryClient()
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [claimOpen, setClaimOpen] = useState(false)
  const [errorBanner, setErrorBanner] = useState<{
    title: string
    description: string
  } | null>(null)
  const [setup, setSetup] = useState<PageSetup | null>(null)
  const [markedConnectionId, setMarkedConnectionId] = useState<string | null>(
    null,
  )

  useGithubConnectorBootstrap(orgSlug)

  const { data: connections, isPending: connectionsPending } = useQuery({
    ...orgConnectionsOptions(orgSlug),
    enabled: true,
  })

  const items = sortOrgConnectionsForDisplay(connections ?? [])
  const showPageLoading = useSkeletonHold(
    connectionsPending && !connections,
    "connectors",
  )
  const showEmptyState = !showPageLoading && items.length === 0
  // Each connect flow ends with a source in a Workspace, and a Workspace
  // below the newest format refuses it (CTX-935). When no Workspace can take
  // a source, say so before the user starts a flow that fails.
  const { data: workspaceList } = useQuery(workspaceListOptions(orgSlug))
  const formatGate = useWorkspaceFormatGate(orgSlug)
  const needUpgrade = (workspaceList?.items ?? []).filter((workspace) =>
    formatGate.needsUpgrade(workspace.slug),
  )
  const connectBlocked =
    needUpgrade.length > 0 && needUpgrade.length === workspaceList?.items.length

  useEffect(() => {
    if (search.pendingAccountClaim) {
      setClaimOpen(true)
    }
  }, [search.pendingAccountClaim])

  const openSetup = (next: Omit<PageSetup, "isOpen">) =>
    setSetup({ ...next, isOpen: true })
  const setupOf = (type: ConnectionType) =>
    setup?.type === type ? setup : null
  const closeSetup = () =>
    setSetup((prev) => prev && { ...prev, isOpen: false })
  // The setups with a key on their connection start again from nothing.
  const clearSetup = () => setSetup(null)
  const changeSetupConnection = (connectionId: string) =>
    setSetup((prev) => prev && { ...prev, connectionId })
  const invalidateConnections = () =>
    void queryClient.invalidateQueries({
      queryKey: orgConnectionsKeys.list(orgSlug),
    })
  const github = setupOf("github")
  const slack = setupOf("slack")
  const forge = setupOf("forge")
  const linear = setupOf("linear")
  const notion = setupOf("notion")
  const pagerduty = setupOf("pagerduty")
  const buildkite = setupOf("buildkite")
  const plain = setupOf("plain")

  // The catalog Fix marks a card for a moment.
  useEffect(() => {
    if (!markedConnectionId) return
    const timer = window.setTimeout(() => setMarkedConnectionId(null), 2000)
    return () => window.clearTimeout(timer)
  }, [markedConnectionId])

  useEffect(() => {
    if (!search.notionConnectionId) return
    setSetup({
      type: "notion",
      connectionId: search.notionConnectionId,
      isOpen: true,
    })
    void navigate({
      to: "/$orgSlug/connectors",
      params: { orgSlug },
      search: (prev) => ({
        error: prev.error,
        error_description: prev.error_description,
        pendingAccountClaim: prev.pendingAccountClaim,
        notionConnectionId: undefined,
      }),
      replace: true,
    })
  }, [search.notionConnectionId, navigate, orgSlug])

  // The Atlassian account link leaves the page; its return path names the
  // connection, so the wizard opens again on the next step.
  useEffect(() => {
    if (!search.atlassianConnectionId) return
    setSetup({
      type: "forge",
      connectionId: search.atlassianConnectionId,
      isOpen: true,
    })
    void navigate({
      to: "/$orgSlug/connectors",
      params: { orgSlug },
      search: (prev) => ({
        error: prev.error,
        error_description: prev.error_description,
        pendingAccountClaim: prev.pendingAccountClaim,
        notionConnectionId: prev.notionConnectionId,
        atlassianConnectionId: undefined,
      }),
      replace: true,
    })
  }, [search.atlassianConnectionId, navigate, orgSlug])

  useEffect(() => {
    if (search.error == null) return
    setErrorBanner(oauthErrorMessage(search.error, search.error_description))
    void navigate({
      to: "/$orgSlug/connectors",
      params: { orgSlug },
      search: (prev) => ({
        error: undefined,
        error_description: undefined,
        pendingAccountClaim: prev.pendingAccountClaim,
        notionConnectionId: prev.notionConnectionId,
      }),
      replace: true,
    })
  }, [search.error, search.error_description, navigate, orgSlug])

  return (
    <main className="mx-auto box-border flex min-h-full w-full max-w-2xl flex-col p-8 text-foreground">
      {errorBanner ? (
        <ConnectorsOAuthErrorBanner
          title={errorBanner.title}
          description={errorBanner.description}
        />
      ) : null}
      <ConnectorsHeader
        actions={
          showEmptyState ? null : (
            <Button
              variant="secondary"
              size="icon"
              className="rounded-md"
              aria-label="Add connection"
              isDisabled={connectBlocked}
              onPress={() => setCatalogOpen(true)}
            >
              <IconPlus className="size-5" aria-hidden />
            </Button>
          )
        }
      />

      {connectBlocked ? (
        <div className="mt-8">
          <FormatUpgradeWorkspacesNotice
            orgSlug={orgSlug}
            workspaces={needUpgrade}
          />
        </div>
      ) : null}

      <section
        className={`mt-12 flex min-h-0 flex-col ${
          showEmptyState ? "" : "border-t border-white/[0.06]"
        }`}
      >
        {showPageLoading ? (
          <ConnectorListSkeleton />
        ) : showEmptyState ? (
          <ConnectorsEmptyState
            isDisabled={connectBlocked}
            onAddConnection={() => setCatalogOpen(true)}
          />
        ) : (
          // One card for each connection. The shared connector shell
          // (CTX-1069) moves this list and the setup dialogs below out of
          // the route; the catalog itself reads only the registry.
          items.map((row) => {
            const marked = row.id === markedConnectionId
            if (row.type === "forge") {
              return (
                <ConfluenceConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                  marked={marked}
                  onOpenWizard={() =>
                    openSetup({ type: "forge", connectionId: row.id })
                  }
                />
              )
            }
            if (row.type === "slack") {
              return (
                <SlackConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                  marked={marked}
                />
              )
            }
            if (row.type === "linear") {
              return (
                <LinearConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                  marked={marked}
                  onOpenWizard={() =>
                    openSetup({ type: "linear", connectionId: row.id })
                  }
                />
              )
            }
            if (row.type === "notion") {
              return (
                <NotionConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                  marked={marked}
                  onOpenSetup={() =>
                    openSetup({ type: "notion", connectionId: row.id })
                  }
                />
              )
            }
            if (row.type === "buildkite") {
              return (
                <BuildkiteConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                  marked={marked}
                  onOpenSetup={(options) =>
                    openSetup({
                      type: "buildkite",
                      connectionId: row.id,
                      replaceWebhook: Boolean(options?.replaceWebhook),
                    })
                  }
                />
              )
            }
            if (row.type === "plain") {
              return (
                <PlainConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                  marked={marked}
                  onOpenSetup={(options) =>
                    openSetup({
                      type: "plain",
                      connectionId: row.id,
                      reconnect: Boolean(options?.reconnect),
                    })
                  }
                />
              )
            }
            if (row.type === "pagerduty") {
              return (
                <PagerdutyConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                  marked={marked}
                  onOpenSetup={() =>
                    openSetup({ type: "pagerduty", connectionId: row.id })
                  }
                />
              )
            }
            return (
              <GithubConnectionCard
                key={row.id}
                orgSlug={orgSlug}
                connectionId={row.id}
                marked={marked}
              />
            )
          })
        )}
      </section>

      <ConnectorCatalogDialog
        orgSlug={orgSlug}
        connections={items}
        isOpen={catalogOpen}
        onOpenChange={setCatalogOpen}
        onOpenSetup={openSetup}
        onFix={setMarkedConnectionId}
      />

      <GithubSelfHostedWizardModal
        orgSlug={orgSlug}
        isOpen={github?.isOpen ?? false}
        onOpenChange={(open) => {
          if (!open) closeSetup()
        }}
        onDraftCreated={({ connectionId }) => {
          queueMicrotask(() => scrollToConnection(connectionId))
        }}
      />

      <SlackSetupDialog
        orgSlug={orgSlug}
        isOpen={slack?.isOpen ?? false}
        onOpenChange={(open) => {
          if (!open) closeSetup()
        }}
      />

      <ConnectorSetupDialog
        orgSlug={orgSlug}
        atlassianConnectionId={forge?.connectionId}
        isOpen={forge?.isOpen ?? false}
        onOpenChange={(open) => {
          if (open) return
          closeSetup()
          invalidateConnections()
        }}
      />

      <LinearSetupWizard
        orgSlug={orgSlug}
        connectionId={linear?.connectionId}
        isOpen={linear?.isOpen ?? false}
        onConnectionIdChange={(connectionId) => {
          changeSetupConnection(connectionId)
          invalidateConnections()
        }}
        onOpenChange={(open) => {
          if (open) return
          closeSetup()
          invalidateConnections()
        }}
      />

      <Modal isOpen={claimOpen} onOpenChange={setClaimOpen} isDismissable>
        <AtlassianAccountClaimModalContent
          onCancel={async () => {
            if (!search.pendingAccountClaim) {
              setClaimOpen(false)
              return
            }
            await client[":orgSlug"].api.v1.connectors.atlassian[
              "pending-claim"
            ][":pendingId"].cancel.$post({
              param: { orgSlug, pendingId: search.pendingAccountClaim },
            })
            setClaimOpen(false)
            void navigate({
              to: "/$orgSlug/connectors",
              params: { orgSlug },
              search: (prev) => ({
                error: prev.error,
                error_description: prev.error_description,
                pendingAccountClaim: undefined,
                notionConnectionId: prev.notionConnectionId,
              }),
              replace: true,
            })
          }}
          onConfirm={async () => {
            if (!search.pendingAccountClaim) {
              setClaimOpen(false)
              return
            }
            try {
              const res = await client[":orgSlug"].api.v1.connectors.atlassian[
                "pending-claim"
              ][":pendingId"].confirm.$post({
                param: { orgSlug, pendingId: search.pendingAccountClaim },
              })
              await readApiJson(res, {
                message: "Failed to confirm Atlassian account claim",
              })
            } catch {
              setClaimOpen(false)
              return
            }
            setClaimOpen(false)
            await queryClient.invalidateQueries({
              queryKey: orgConnectionsKeys.list(orgSlug),
            })
            await queryClient.invalidateQueries({
              queryKey: atlassianConnectorKeys.allStatusForOrg(orgSlug),
            })
            void navigate({
              to: "/$orgSlug/connectors",
              params: { orgSlug },
              search: (prev) => ({
                error: prev.error,
                error_description: prev.error_description,
                pendingAccountClaim: undefined,
                notionConnectionId: prev.notionConnectionId,
              }),
              replace: true,
            })
          }}
        />
      </Modal>

      <NotionSetupDialog
        key={notion?.connectionId ?? "notion-setup"}
        orgSlug={orgSlug}
        connectionId={notion?.connectionId}
        isOpen={notion?.isOpen ?? false}
        onConnectionIdChange={changeSetupConnection}
        onOpenChange={(open) => {
          if (!open) clearSetup()
        }}
      />

      <PagerdutySetupDialog
        key={pagerduty?.connectionId ?? "pagerduty-setup"}
        orgSlug={orgSlug}
        connectionId={pagerduty?.connectionId}
        isOpen={pagerduty?.isOpen ?? false}
        onConnectionIdChange={(nextConnectionId) => {
          changeSetupConnection(nextConnectionId)
          invalidateConnections()
        }}
        onOpenChange={(open) => {
          if (!open) clearSetup()
        }}
      />

      <BuildkiteSetupDialog
        key={buildkite?.connectionId ?? "buildkite-setup"}
        orgSlug={orgSlug}
        connectionId={buildkite?.connectionId}
        replaceWebhook={Boolean(buildkite?.replaceWebhook)}
        isOpen={buildkite?.isOpen ?? false}
        onConnectionIdChange={changeSetupConnection}
        onOpenChange={(open) => {
          if (!open) clearSetup()
        }}
      />

      <PlainSetupDialog
        key={plain?.connectionId ?? "plain-setup"}
        orgSlug={orgSlug}
        connectionId={plain?.connectionId}
        reconnect={Boolean(plain?.reconnect)}
        isOpen={plain?.isOpen ?? false}
        onConnectionIdChange={changeSetupConnection}
        onOpenChange={(open) => {
          if (!open) clearSetup()
        }}
      />
    </main>
  )
}

function ConnectorsHeader(props: { actions: ReactNode }) {
  return (
    <>
      <header className="mb-8">
        <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
          Connectors
        </span>
      </header>
      <section>
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-medium tracking-tight text-foreground">
              Connectors
            </h1>
            <p className="mt-3 leading-relaxed text-muted-foreground">
              Connect external tools and choose what content ctxpipe should
              ingest.
            </p>
          </div>
          {props.actions ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pt-1">
              {props.actions}
            </div>
          ) : null}
        </div>
      </section>
    </>
  )
}
