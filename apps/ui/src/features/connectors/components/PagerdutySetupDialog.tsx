"use client"

import { IconExternalLink, IconSearch } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import { workspaceListOptions } from "@/features/workspaces/queries"
import type { Workspace } from "@/features/workspaces/types"
import {
  consumePagerdutySetupPopupResult,
  PAGERDUTY_SETUP_RESULT_KEY,
} from "@/lib/popup"
import {
  getPagerdutyFailureAction,
  getPagerdutySetupCurrentIndex,
  getPagerdutySetupSteps,
  hasPagerdutyScopeChanged,
  shouldShowPagerdutySetupComplete,
} from "../pagerduty-setup-model"
import {
  connectorSyncTargetKeys,
  fetchSuggestedConnectorSyncTarget,
} from "../queries/connector-sync-target"
import { orgConnectionsKeys } from "../queries/org-connections"
import {
  fetchPagerdutyConnectorConfig,
  fetchPagerdutyConnectorStatus,
  type PagerdutyService,
  pagerdutyConnectorKeys,
  patchPagerdutyConnectorConfig,
  retryPagerdutyConfig,
  retryPagerdutySync,
  searchPagerdutyServices,
} from "../queries/pagerduty-connector"
import { ConnectorSetupStepper } from "./ConnectorSetupStepper"
import {
  ConnectorWorkspaceDestinationPicker,
  destinationFromWorkspace,
  workspaceMatchingGitUrl,
} from "./ConnectorWorkspaceDestinationPicker"
import { GitHubPrerequisiteStep } from "./GitHubPrerequisiteStep"
import { PagerdutyConnectStep } from "./PagerdutyConnectStep"
import { PagerdutyMark } from "./PagerdutyMark"
import { PagerdutyRegisterOauthStep } from "./PagerdutyRegisterOauthStep"

type PagerdutySetupDialogProps = {
  orgSlug: string
  connectionId?: string
  githubConnectionIds?: string[]
  manageScope?: boolean
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onConnectionIdChange: (connectionId: string) => void
}

export function PagerdutySetupDialog(props: PagerdutySetupDialogProps) {
  return (
    <PagerdutySetupDialogContent
      key={`${props.connectionId ?? "new"}:${props.manageScope ? "manage" : "setup"}`}
      {...props}
    />
  )
}

function PagerdutySetupDialogContent({
  orgSlug,
  connectionId,
  githubConnectionIds = [],
  manageScope = false,
  isOpen,
  onOpenChange,
  onConnectionIdChange,
}: PagerdutySetupDialogProps) {
  const queryClient = useQueryClient()
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(
    null,
  )
  const [serviceSearch, setServiceSearch] = useState("")
  const [debouncedServiceSearch, setDebouncedServiceSearch] = useState("")
  const [serviceOffset, setServiceOffset] = useState(0)
  const [selectedServices, setSelectedServices] = useState<PagerdutyService[]>(
    [],
  )
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    const acceptResult = (value: unknown) => {
      if (!value || typeof value !== "object") return
      const data = value as Record<string, unknown>
      if (
        data.type === "pagerduty-oauth-error" &&
        data.orgSlug === orgSlug &&
        typeof data.error === "string"
      ) {
        toast.error(data.error)
        return
      }
      if (
        data.type !== "pagerduty-oauth-complete" ||
        data.orgSlug !== orgSlug ||
        typeof data.connectionId !== "string"
      ) {
        return
      }
      onConnectionIdChange(data.connectionId)
      void queryClient.invalidateQueries({
        queryKey: pagerdutyConnectorKeys.allStatusForOrg(orgSlug),
      })
      void queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
    }
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) return
      acceptResult(event.data)
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== PAGERDUTY_SETUP_RESULT_KEY || !event.newValue) return
      try {
        acceptResult(JSON.parse(event.newValue) as unknown)
      } catch {
        // The signed OAuth callback is the only writer; ignore malformed values.
      } finally {
        consumePagerdutySetupPopupResult()
      }
    }
    const storedResult = window.localStorage.getItem(PAGERDUTY_SETUP_RESULT_KEY)
    if (storedResult) {
      try {
        acceptResult(JSON.parse(storedResult) as unknown)
      } catch {
        // The signed OAuth callback is the only writer; ignore malformed values.
      } finally {
        consumePagerdutySetupPopupResult()
      }
    }
    window.addEventListener("message", handleMessage)
    window.addEventListener("storage", handleStorage)
    return () => {
      window.removeEventListener("message", handleMessage)
      window.removeEventListener("storage", handleStorage)
    }
  }, [isOpen, onConnectionIdChange, orgSlug, queryClient])

  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedServiceSearch(serviceSearch)
      setServiceOffset(0)
    }, 300)
    return () => clearTimeout(id)
  }, [serviceSearch])

  const statusQuery = useQuery({
    queryKey: pagerdutyConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchPagerdutyConnectorStatus(orgSlug, connectionId),
    enabled: isOpen && Boolean(connectionId),
    refetchInterval: (query) => {
      const data = query.state.data
      if (!isOpen) return false
      if (
        data?.setupPhase === "awaiting_merge" ||
        data?.setupPhase === "initial_sync" ||
        data?.pendingConfigPrCreating
      ) {
        return 2000
      }
      return false
    },
  })
  const isPagerdutyInstalled = statusQuery.data?.isInstalled === true

  const configQuery = useQuery({
    queryKey: pagerdutyConnectorKeys.config(orgSlug, connectionId),
    queryFn: () => fetchPagerdutyConnectorConfig(orgSlug, connectionId),
    enabled: isOpen && Boolean(connectionId) && isPagerdutyInstalled,
  })

  const suggestedTargetQuery = useQuery({
    queryKey: connectorSyncTargetKeys.suggestion(orgSlug),
    queryFn: () => fetchSuggestedConnectorSyncTarget(orgSlug),
    enabled:
      isOpen &&
      isPagerdutyInstalled &&
      Boolean(statusQuery.data?.isGithubLinked) &&
      !statusQuery.data?.syncTargetConfigured,
  })

  const activeGithubConnectionId =
    configQuery.data?.syncTarget?.githubConnectionId ??
    suggestedTargetQuery.data?.githubConnectionId ??
    (githubConnectionIds.length === 1 ? githubConnectionIds[0] : undefined)

  const workspacesQuery = useQuery({
    ...workspaceListOptions(orgSlug),
    enabled: isOpen,
  })

  useEffect(() => {
    const config = configQuery.data
    if (initialized || config === undefined || suggestedTargetQuery.isPending)
      return
    setSelectedServices(config?.services ?? [])
    if (config?.syncTarget) {
      setSelectedWorkspace(
        workspaceMatchingGitUrl(
          workspacesQuery.data?.items ?? [],
          `https://github.com/${config.syncTarget.repositoryName}.git`,
        ),
      )
    }
    setInitialized(true)
  }, [
    configQuery.data,
    initialized,
    workspacesQuery.data?.items,
    suggestedTargetQuery.isPending,
  ])

  const servicesQuery = useQuery({
    queryKey: pagerdutyConnectorKeys.services(
      orgSlug,
      connectionId,
      debouncedServiceSearch,
      serviceOffset,
    ),
    queryFn: () =>
      searchPagerdutyServices(orgSlug, {
        q: debouncedServiceSearch,
        offset: serviceOffset,
        connectionId,
      }),
    enabled: isOpen && Boolean(connectionId) && isPagerdutyInstalled,
  })

  const selectedIds = useMemo(
    () => new Set(selectedServices.map((service) => service.id)),
    [selectedServices],
  )
  const saveTargetMutation = useMutation({
    mutationFn: async () => {
      if (!selectedWorkspace) throw new Error("Select a workspace")
      const destination = destinationFromWorkspace(selectedWorkspace)
      return patchPagerdutyConnectorConfig(
        orgSlug,
        {
          syncTarget: {
            repositoryName: destination.repositoryName,
            gitUrl: destination.gitUrl,
            githubConnectionId:
              destination.githubConnectionId ??
              activeGithubConnectionId ??
              undefined,
            branch: destination.branch,
            enabled: true,
          },
        },
        connectionId,
      )
    },
    onSuccess: async () => {
      toast.success("PagerDuty sync target saved.")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: pagerdutyConnectorKeys.status(orgSlug, connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: pagerdutyConnectorKeys.config(orgSlug, connectionId),
        }),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const saveServicesMutation = useMutation({
    mutationFn: () =>
      patchPagerdutyConnectorConfig(
        orgSlug,
        { services: selectedServices },
        connectionId,
      ),
    onSuccess: async ({ savedCount, configPrEnqueued }) => {
      toast.success(
        configPrEnqueued
          ? `Scope saved (${savedCount} services). A pull request for pagerduty/config.yaml is being created.`
          : `Scope saved (${savedCount} services).`,
      )
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: pagerdutyConnectorKeys.status(orgSlug, connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: pagerdutyConnectorKeys.config(orgSlug, connectionId),
        }),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const retrySyncMutation = useMutation({
    mutationFn: () => {
      if (!connectionId) throw new Error("Missing PagerDuty connection")
      return retryPagerdutySync(orgSlug, connectionId)
    },
    onSuccess: async () => {
      toast.success("PagerDuty content sync retry started.")
      await queryClient.invalidateQueries({
        queryKey: pagerdutyConnectorKeys.status(orgSlug, connectionId),
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const retryConfigMutation = useMutation({
    mutationFn: () => {
      if (!connectionId) throw new Error("Missing PagerDuty connection")
      return retryPagerdutyConfig(
        orgSlug,
        connectionId,
        selectedServices.length > 0 ? selectedServices : undefined,
      )
    },
    onSuccess: async () => {
      toast.success("Configuration pull request retry started.")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: pagerdutyConnectorKeys.status(orgSlug, connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: pagerdutyConnectorKeys.config(orgSlug, connectionId),
        }),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const oauthMeta = statusQuery.data
    ? {
        globalPagerdutyOAuthConfigured:
          statusQuery.data.globalPagerdutyOAuthConfigured,
        oauthAppSaved: statusQuery.data.oauthAppSaved,
      }
    : undefined
  const status = connectionId
    ? statusQuery.data
    : {
        isInstalled: false,
        installationStatus: null,
        accountName: null,
        accountSubdomain: null,
        region: null,
        isGithubLinked: false,
        selectedServiceCount: null,
        syncTargetConfigured: false,
        setupPhase: "draft",
        pendingConfigPullUrl: null,
        pendingConfigPrCreating: false,
        syncTarget: null,
        oauthAppSaved: false,
        globalPagerdutyOAuthConfigured: true,
        oauthCallbackUrl: "",
      }
  const config = configQuery.data
  const failureAction = status ? getPagerdutyFailureAction(status) : null
  const scopeChanged = hasPagerdutyScopeChanged(
    config?.services ?? [],
    selectedServices,
  )
  const editingLiveScope = status?.setupPhase === "live" && manageScope
  const setupSteps = getPagerdutySetupSteps(oauthMeta)
  const setupStepIndex = status
    ? getPagerdutySetupCurrentIndex(status, oauthMeta)
    : 0
  const needsRegister =
    Boolean(connectionId) &&
    oauthMeta !== undefined &&
    !oauthMeta.globalPagerdutyOAuthConfigured &&
    !oauthMeta.oauthAppSaved &&
    !status?.isInstalled

  const body = (() => {
    if (
      connectionId &&
      (statusQuery.isPending || (isPagerdutyInstalled && configQuery.isPending))
    ) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading PagerDuty connector...
        </div>
      )
    }
    if (connectionId && statusQuery.isError) {
      return (
        <div className="space-y-3 text-sm">
          <p className="text-destructive">
            Could not load PagerDuty connector status.
          </p>
          <Button
            variant="secondary"
            className="rounded-none"
            onPress={() => void statusQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      )
    }
    if (needsRegister && connectionId) {
      return (
        <PagerdutyRegisterOauthStep
          orgSlug={orgSlug}
          connectionId={connectionId}
          oauthCallbackUrl={status?.oauthCallbackUrl ?? ""}
        />
      )
    }
    if (!status?.isInstalled) {
      return (
        <PagerdutyConnectStep
          orgSlug={orgSlug}
          connectionId={connectionId}
          revoked={status?.installationStatus === "revoked"}
        />
      )
    }
    if (!status.isGithubLinked) {
      return (
        <GitHubPrerequisiteStep
          orgSlug={orgSlug}
          sourceName="PagerDuty"
          onConnected={async () => {
            await queryClient.invalidateQueries({
              queryKey: pagerdutyConnectorKeys.status(orgSlug, connectionId),
            })
          }}
        />
      )
    }
    if (!status.syncTargetConfigured) {
      return (
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-medium text-foreground">
              Select a workspace for PagerDuty content
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              PagerDuty incidents are mirrored into that workspace repository.
            </p>
          </div>
          <ConnectorWorkspaceDestinationPicker
            orgSlug={orgSlug}
            selectedWorkspaceId={
              selectedWorkspace?.id ??
              workspaceMatchingGitUrl(
                workspacesQuery.data?.items ?? [],
                configQuery.data?.syncTarget
                  ? `https://github.com/${configQuery.data.syncTarget.repositoryName}.git`
                  : null,
              )?.id ??
              null
            }
            onSelect={setSelectedWorkspace}
          />
          <div className="flex justify-end border-t border-border pt-4">
            <Button
              variant="primary"
              className="rounded-md"
              isPending={saveTargetMutation.isPending}
              isDisabled={!selectedWorkspace}
              onPress={() => void saveTargetMutation.mutateAsync()}
            >
              Continue
            </Button>
          </div>
        </div>
      )
    }
    if (failureAction === "retry_content") {
      return (
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-medium text-foreground">
              PagerDuty content sync failed
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Your approved configuration remains intact. Retry the content
              mirror without creating another pull request.
            </p>
          </div>
          <Button
            variant="primary"
            className="rounded-none"
            isPending={retrySyncMutation.isPending}
            onPress={() => retrySyncMutation.mutate()}
          >
            Retry content sync
          </Button>
        </div>
      )
    }
    if (
      failureAction === "retry_config" &&
      (selectedServices.length > 0 || status.pendingConfigPullUrl)
    ) {
      return (
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-medium text-foreground">
              Configuration pull request failed
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Retry creating the reviewable configuration pull request.
              PagerDuty incidents are not synchronised until the pull request is
              merged.
            </p>
          </div>
          <Button
            variant="primary"
            className="rounded-none"
            isPending={retryConfigMutation.isPending}
            onPress={() => retryConfigMutation.mutate()}
          >
            Retry configuration pull request
          </Button>
        </div>
      )
    }
    if (
      status.pendingConfigPrCreating ||
      status.pendingConfigPullUrl ||
      status.setupPhase === "awaiting_merge" ||
      status.setupPhase === "initial_sync"
    ) {
      const creatingPullRequest = status.pendingConfigPrCreating
      const syncingAfterMerge = status.setupPhase === "initial_sync"
      return (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {syncingAfterMerge ? (
              <>
                Your configuration is merged. We are syncing PagerDuty incidents
                to Git from{" "}
                <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                  pagerduty/config.yaml
                </code>
                .
              </>
            ) : (
              <>
                ctxpipe first proposes only the approved sync scope in{" "}
                <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                  pagerduty/config.yaml
                </code>
                . Review and merge the pull request before any PagerDuty
                incidents are mirrored.
              </>
            )}
          </p>
          {syncingAfterMerge ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Syncing PagerDuty incidents to Git…
            </div>
          ) : status.pendingConfigPullUrl ? (
            <Button
              variant="outline"
              className="rounded-none"
              onPress={() =>
                window.open(
                  status.pendingConfigPullUrl ?? "",
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              Open pull request
              <IconExternalLink className="size-4" aria-hidden />
            </Button>
          ) : creatingPullRequest ? (
            <div className="space-y-2 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <Spinner className="size-4" />
                Creating pull request…
              </div>
              <p>
                This usually takes 30–90 seconds while ctxpipe starts the sync
                worker and prepares the repository. You can close this dialog;
                setup will continue in the background.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Pull request creation failed. Try again; if it continues to
                fail, check that the GitHub App can write to the repository.
              </p>
              <Button
                variant="outline"
                className="rounded-none"
                isPending={saveServicesMutation.isPending}
                onPress={() => saveServicesMutation.mutate()}
              >
                Try creating pull request again
              </Button>
            </div>
          )}
        </div>
      )
    }
    if (shouldShowPagerdutySetupComplete(status, manageScope)) {
      return (
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-medium text-foreground">
              PagerDuty is connected
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              The approved scope is stored in{" "}
              <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                pagerduty/config.yaml
              </code>
              , and incidents from the selected services are now mirrored to
              Git. You can manage scope later from the connector card.
            </p>
          </div>
          <Button
            variant="secondary"
            className="rounded-none"
            onPress={() => onOpenChange(false)}
          >
            Close
          </Button>
        </div>
      )
    }

    const page = servicesQuery.data?.items ?? []
    return (
      <div className="space-y-4">
        {failureAction === "retry_config" ? (
          <div className="border border-destructive/50 bg-destructive/10 p-3 text-sm">
            <p className="font-medium text-foreground">
              Configuration pull request failed
            </p>
            <p className="mt-1 text-muted-foreground">
              Select the PagerDuty services again, then retry creating the pull
              request.
            </p>
          </div>
        ) : null}
        <div>
          <h3 className="text-base font-medium text-foreground">
            {editingLiveScope
              ? "Manage PagerDuty scope"
              : "Select PagerDuty services"}
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {editingLiveScope ? (
              <>
                Scope changes are proposed through{" "}
                <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                  pagerduty/config.yaml
                </code>
                . Sync updates after you review and merge the pull request.
              </>
            ) : (
              <>
                Pick the services ctx| should mirror into GitHub. Your selection
                is proposed in{" "}
                <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                  pagerduty/config.yaml
                </code>{" "}
                and incident sync begins after you merge the pull request.
                Search and page through the account&apos;s services.
              </>
            )}
          </p>
        </div>
        <label className="flex items-center gap-2 rounded-none border border-border bg-card/40 px-3 py-2 text-sm">
          <IconSearch className="size-4 shrink-0 text-muted-foreground" />
          <input
            value={serviceSearch}
            onChange={(event) => setServiceSearch(event.target.value)}
            placeholder="Search PagerDuty services"
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <div className="max-h-72 overflow-auto border border-border">
          {servicesQuery.isFetching ? (
            <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Searching PagerDuty...
            </div>
          ) : servicesQuery.isError ? (
            <p className="p-3 text-sm text-destructive">
              Failed to load PagerDuty services. Try again.
            </p>
          ) : page.length === 0 ? (
            <div className="space-y-3 p-3">
              <p className="text-sm text-muted-foreground">
                This PagerDuty account has no services yet. Create one in
                PagerDuty, then refresh this list.
              </p>
              <div className="flex flex-wrap gap-2">
                {status.accountSubdomain ? (
                  <Button
                    variant="secondary"
                    className="rounded-none"
                    onPress={() =>
                      window.open(
                        status.region === "eu"
                          ? `https://${status.accountSubdomain}.eu.pagerduty.com/service-directory`
                          : `https://${status.accountSubdomain}.pagerduty.com/service-directory`,
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                  >
                    Open service directory
                    <IconExternalLink className="size-4" aria-hidden />
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  className="rounded-none"
                  isPending={servicesQuery.isFetching}
                  onPress={() => void servicesQuery.refetch()}
                >
                  Refresh services
                </Button>
              </div>
            </div>
          ) : (
            page.map((service) => (
              <label
                key={service.id}
                className="flex cursor-pointer items-start gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-foreground/[0.03]"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(service.id)}
                  onChange={(event) => {
                    if (event.currentTarget.checked) {
                      setSelectedServices((prev) =>
                        prev.some((item) => item.id === service.id)
                          ? prev
                          : [...prev, service],
                      )
                    } else {
                      setSelectedServices((prev) =>
                        prev.filter((item) => item.id !== service.id),
                      )
                    }
                  }}
                  className="mt-1"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-foreground">
                    {service.name}
                  </span>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {service.id}
                  </span>
                </span>
              </label>
            ))
          )}
        </div>
        <div className="flex items-center justify-between text-sm">
          <Button
            variant="secondary"
            className="rounded-none"
            isDisabled={serviceOffset === 0}
            onPress={() =>
              setServiceOffset((offset) => Math.max(0, offset - 25))
            }
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            className="rounded-none"
            isDisabled={!servicesQuery.data?.more}
            onPress={() => setServiceOffset((offset) => offset + 25)}
          >
            Next
          </Button>
        </div>
        {selectedServices.length > 0 ? (
          <div className="text-sm text-muted-foreground">
            {selectedServices.length} selected
          </div>
        ) : null}
        <Button
          variant="primary"
          className="rounded-none"
          isPending={
            failureAction === "retry_config"
              ? retryConfigMutation.isPending
              : saveServicesMutation.isPending
          }
          isDisabled={
            failureAction === "retry_config"
              ? selectedServices.length === 0
              : config === null ||
                !scopeChanged ||
                (!editingLiveScope && selectedServices.length === 0)
          }
          onPress={() =>
            void (failureAction === "retry_config"
              ? retryConfigMutation.mutateAsync()
              : saveServicesMutation.mutateAsync())
          }
        >
          {failureAction === "retry_config"
            ? "Retry configuration pull request"
            : editingLiveScope
              ? "Propose scope changes"
              : "Create configuration pull request"}
        </Button>
      </div>
    )
  })()

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="max-w-[min(92vw,720px)]"
    >
      <div className="p-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            <span className="ctx-node h-9 w-9">
              <PagerdutyMark className="size-5 text-foreground" />
            </span>
            <div>
              <h2 className="text-lg font-medium tracking-tight text-foreground">
                Set up PagerDuty connector
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Authorise PagerDuty, choose Git scope, then approve the
                generated configuration.
              </p>
            </div>
          </div>
          <Button
            variant="secondary"
            className="rounded-none"
            onPress={() => onOpenChange(false)}
          >
            Close
          </Button>
        </div>
        {status && !(connectionId && statusQuery.isPending) ? (
          <div className="mb-6">
            <ConnectorSetupStepper
              steps={setupSteps}
              currentIndex={setupStepIndex}
            />
          </div>
        ) : null}
        {body}
      </div>
    </Modal>
  )
}
