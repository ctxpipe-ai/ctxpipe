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
  AddBuildkiteConnectorButton,
  AddConfluenceConnectorButton,
  AddConnectorCatalogDialog,
  AddGithubConnectorButton,
  AddLinearConnectorButton,
  AddNotionConnectorButton,
  AddPagerdutyConnectorButton,
  AddPlainConnectorButton,
  AddSlackConnectorButton,
  AddZendeskConnectorButton,
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
  ZendeskConnectionCard,
  ZendeskSetupDialog,
} from "@/features/connectors"
import { AtlassianAccountClaimModalContent } from "@/features/connectors/components/AtlassianAccountClaimModalContent"
import { ConnectorListSkeleton } from "@/features/connectors/components/ConnectorListItem"
import { ConnectorsOAuthErrorBanner } from "@/features/connectors/components/ConnectorsOAuthErrorBanner"
import { GithubSelfHostedWizardModal } from "@/features/connectors/components/GithubSelfHostedWizardModal"
import { SlackSetupDialog } from "@/features/connectors/components/SlackSetupDialog"
import { atlassianConnectorKeys } from "@/features/connectors/queries/atlassian-connector"
import {
  orgConnectionsKeys,
  orgConnectionsOptions,
  sortOrgConnectionsForDisplay,
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
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardAtlassianConnectionId, setWizardAtlassianConnectionId] =
    useState<string | undefined>(undefined)
  const [notionSetupOpen, setNotionSetupOpen] = useState(false)
  const [pagerdutySetupOpen, setPagerdutySetupOpen] = useState(false)
  const [notionConnectionId, setNotionConnectionId] = useState<string | null>(
    null,
  )
  const [pagerdutyConnectionId, setPagerdutyConnectionId] = useState<
    string | null
  >(null)
  const [buildkiteSetupOpen, setBuildkiteSetupOpen] = useState(false)
  const [buildkiteConnectionId, setBuildkiteConnectionId] = useState<
    string | null
  >(null)
  const [buildkiteReplaceWebhook, setBuildkiteReplaceWebhook] = useState(false)
  const [plainSetupOpen, setPlainSetupOpen] = useState(false)
  const [plainConnectionId, setPlainConnectionId] = useState<string | null>(
    null,
  )
  const [plainReconnect, setPlainReconnect] = useState(false)
  const [zendeskSetupOpen, setZendeskSetupOpen] = useState(false)
  const [zendeskConnectionId, setZendeskConnectionId] = useState<string | null>(
    null,
  )
  const [zendeskReconnect, setZendeskReconnect] = useState(false)
  const [githubSelfHostedWizardOpen, setGithubSelfHostedWizardOpen] =
    useState(false)
  const [slackSetupOpen, setSlackSetupOpen] = useState(false)
  const [linearWizardOpen, setLinearWizardOpen] = useState(false)
  const [linearConnectionId, setLinearConnectionId] = useState<
    string | undefined
  >(undefined)

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

  useEffect(() => {
    if (!search.notionConnectionId) return
    setNotionConnectionId(search.notionConnectionId)
    setNotionSetupOpen(true)
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
    setWizardAtlassianConnectionId(search.atlassianConnectionId)
    setWizardOpen(true)
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
          items.map((row) => {
            if (row.type === "forge") {
              return (
                <ConfluenceConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                  onOpenWizard={() => {
                    setWizardAtlassianConnectionId(row.id)
                    setWizardOpen(true)
                  }}
                />
              )
            }
            if (row.type === "slack") {
              return (
                <SlackConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                />
              )
            }
            if (row.type === "linear") {
              return (
                <LinearConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                  onOpenWizard={() => {
                    setLinearConnectionId(row.id)
                    setLinearWizardOpen(true)
                  }}
                />
              )
            }
            if (row.type === "notion") {
              return (
                <NotionConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                  onOpenSetup={() => {
                    setNotionConnectionId(row.id)
                    setNotionSetupOpen(true)
                  }}
                />
              )
            }
            if (row.type === "buildkite") {
              return (
                <BuildkiteConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                  onOpenSetup={(options) => {
                    setBuildkiteConnectionId(row.id)
                    setBuildkiteReplaceWebhook(Boolean(options?.replaceWebhook))
                    setBuildkiteSetupOpen(true)
                  }}
                />
              )
            }
            if (row.type === "plain") {
              return (
                <PlainConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                  onOpenSetup={(options) => {
                    setPlainConnectionId(row.id)
                    setPlainReconnect(Boolean(options?.reconnect))
                    setPlainSetupOpen(true)
                  }}
                />
              )
            }
            if (row.type === "zendesk") {
              return (
                <ZendeskConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                  onOpenSetup={(options) => {
                    setZendeskConnectionId(row.id)
                    setZendeskReconnect(Boolean(options?.reconnect))
                    setZendeskSetupOpen(true)
                  }}
                />
              )
            }
            if (row.type === "pagerduty") {
              return (
                <PagerdutyConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                  onOpenSetup={() => {
                    setPagerdutyConnectionId(row.id)
                    setPagerdutySetupOpen(true)
                  }}
                />
              )
            }
            return (
              <GithubConnectionCard
                key={row.id}
                orgSlug={orgSlug}
                connectionId={row.id}
              />
            )
          })
        )}
      </section>

      <AddConnectorCatalogDialog
        isOpen={catalogOpen}
        onOpenChange={setCatalogOpen}
      >
        <li>
          <AddGithubConnectorButton
            orgSlug={orgSlug}
            onRequestSelfHostedWizard={() => {
              setCatalogOpen(false)
              setGithubSelfHostedWizardOpen(true)
            }}
          />
        </li>
        <li>
          <AddConfluenceConnectorButton
            orgSlug={orgSlug}
            onInstallIntentRegistered={({ connectionId }) => {
              setWizardAtlassianConnectionId(connectionId)
              setWizardOpen(true)
              setCatalogOpen(false)
            }}
          />
        </li>
        <li>
          <AddSlackConnectorButton
            orgSlug={orgSlug}
            onOpenSetup={() => {
              setCatalogOpen(false)
              setSlackSetupOpen(true)
            }}
          />
        </li>
        <li>
          <AddLinearConnectorButton
            orgSlug={orgSlug}
            onStart={(connectionId) => {
              setLinearConnectionId(connectionId)
              setLinearWizardOpen(true)
              setCatalogOpen(false)
            }}
          />
        </li>
        <li>
          <AddNotionConnectorButton
            orgSlug={orgSlug}
            onStart={({ connectionId }) => {
              setNotionConnectionId(connectionId)
              setNotionSetupOpen(true)
              setCatalogOpen(false)
            }}
          />
        </li>
        <li>
          <AddPagerdutyConnectorButton
            orgSlug={orgSlug}
            onStart={({ connectionId }) => {
              setPagerdutyConnectionId(connectionId ?? null)
              setPagerdutySetupOpen(true)
              setCatalogOpen(false)
            }}
          />
        </li>
        <li>
          <AddBuildkiteConnectorButton
            onStart={() => {
              setBuildkiteConnectionId(null)
              setBuildkiteReplaceWebhook(false)
              setBuildkiteSetupOpen(true)
              setCatalogOpen(false)
            }}
          />
        </li>
        <li>
          <AddPlainConnectorButton
            onStart={() => {
              setPlainConnectionId(null)
              setPlainReconnect(false)
              setPlainSetupOpen(true)
              setCatalogOpen(false)
            }}
          />
        </li>
        <li>
          <AddZendeskConnectorButton
            onStart={() => {
              setZendeskConnectionId(null)
              setZendeskReconnect(false)
              setZendeskSetupOpen(true)
              setCatalogOpen(false)
            }}
          />
        </li>
      </AddConnectorCatalogDialog>

      <GithubSelfHostedWizardModal
        orgSlug={orgSlug}
        isOpen={githubSelfHostedWizardOpen}
        onOpenChange={setGithubSelfHostedWizardOpen}
        onInstallFlowStarted={() => setCatalogOpen(false)}
        onDraftCreated={({ connectionId }) => {
          queueMicrotask(() => {
            document
              .getElementById(`connector-github-${connectionId}`)
              ?.scrollIntoView({
                behavior: "smooth",
                block: "nearest",
              })
          })
        }}
      />

      <SlackSetupDialog
        orgSlug={orgSlug}
        isOpen={slackSetupOpen}
        onOpenChange={setSlackSetupOpen}
      />

      <ConnectorSetupDialog
        orgSlug={orgSlug}
        atlassianConnectionId={wizardAtlassianConnectionId}
        isOpen={wizardOpen}
        onOpenChange={(open) => {
          setWizardOpen(open)
          if (!open) {
            void queryClient.invalidateQueries({
              queryKey: orgConnectionsKeys.list(orgSlug),
            })
          }
        }}
      />

      <LinearSetupWizard
        orgSlug={orgSlug}
        connectionId={linearConnectionId}
        isOpen={linearWizardOpen}
        onConnectionIdChange={(connectionId) => {
          setLinearConnectionId(connectionId)
          void queryClient.invalidateQueries({
            queryKey: orgConnectionsKeys.list(orgSlug),
          })
        }}
        onOpenChange={(open) => {
          setLinearWizardOpen(open)
          if (!open) {
            void queryClient.invalidateQueries({
              queryKey: orgConnectionsKeys.list(orgSlug),
            })
          }
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
        key={notionConnectionId ?? "notion-setup"}
        orgSlug={orgSlug}
        connectionId={notionConnectionId ?? undefined}
        isOpen={notionSetupOpen}
        onConnectionIdChange={setNotionConnectionId}
        onOpenChange={(open) => {
          setNotionSetupOpen(open)
          if (!open) {
            setNotionConnectionId(null)
          }
        }}
      />

      <PagerdutySetupDialog
        key={pagerdutyConnectionId ?? "pagerduty-setup"}
        orgSlug={orgSlug}
        connectionId={pagerdutyConnectionId ?? undefined}
        isOpen={pagerdutySetupOpen}
        onConnectionIdChange={(nextConnectionId) => {
          setPagerdutyConnectionId(nextConnectionId)
          void queryClient.invalidateQueries({
            queryKey: orgConnectionsKeys.list(orgSlug),
          })
        }}
        onOpenChange={(open) => {
          setPagerdutySetupOpen(open)
          if (!open) {
            setPagerdutyConnectionId(null)
          }
        }}
      />

      <BuildkiteSetupDialog
        key={buildkiteConnectionId ?? "buildkite-setup"}
        orgSlug={orgSlug}
        connectionId={buildkiteConnectionId ?? undefined}
        replaceWebhook={buildkiteReplaceWebhook}
        isOpen={buildkiteSetupOpen}
        onConnectionIdChange={setBuildkiteConnectionId}
        onOpenChange={(open) => {
          setBuildkiteSetupOpen(open)
          if (!open) setBuildkiteConnectionId(null)
        }}
      />

      <PlainSetupDialog
        key={plainConnectionId ?? "plain-setup"}
        orgSlug={orgSlug}
        connectionId={plainConnectionId ?? undefined}
        reconnect={plainReconnect}
        isOpen={plainSetupOpen}
        onConnectionIdChange={setPlainConnectionId}
        onOpenChange={(open) => {
          setPlainSetupOpen(open)
          if (!open) setPlainConnectionId(null)
        }}
      />

      <ZendeskSetupDialog
        key={zendeskConnectionId ?? "zendesk-setup"}
        orgSlug={orgSlug}
        connectionId={zendeskConnectionId ?? undefined}
        reconnect={zendeskReconnect}
        isOpen={zendeskSetupOpen}
        onConnectionIdChange={setZendeskConnectionId}
        onOpenChange={(open) => {
          setZendeskSetupOpen(open)
          if (!open) setZendeskConnectionId(null)
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
