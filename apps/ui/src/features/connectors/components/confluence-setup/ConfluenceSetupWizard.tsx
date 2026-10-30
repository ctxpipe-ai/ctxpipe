"use client"

import HyperDX from "@hyperdx/browser"
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import { AddToWorkspacesStep } from "@/features/workspace-sources/AddToWorkspacesStep"
import { PullRequestsToMerge } from "@/features/workspace-sources/PullRequestsToMerge"
import type { OpenedPullRequest } from "@/features/workspace-sources/useAddToWorkspaces"
import { pollWhileOk } from "@/lib/api-result"

import {
  getConfluenceCardCurrentIndex,
  getConfluenceCardStepDefs,
  getConfluenceWizardBodyId,
  getConfluenceWizardBodyIdForStepIndex,
} from "../../confluence-setup-model"
import {
  atlassianConnectorKeys,
  cancelAtlassianSetup,
  fetchAtlassianConnectorStatus,
  fetchOrgAtlassianOauth,
} from "../../queries/atlassian-connector"
import { orgConnectionsKeys } from "../../queries/org-connections"
import type { AtlassianConnectorStatus } from "../../types"
import { ConfluenceMark } from "../ConfluenceMark"
import { ConnectorSetupStepper } from "../ConnectorSetupStepper"
import { InstallForgeStep } from "./steps/InstallForgeStep"
import { LinkAtlassianStep } from "./steps/LinkAtlassianStep"
import { RegisterAtlassianOauthStep } from "./steps/RegisterAtlassianOauthStep"
import { WaitForInstallStep } from "./steps/WaitForInstallStep"

type ConfluenceSetupWizardProps = {
  orgSlug: string
  /** When set, wizard reads/writes this Forge connection only. */
  atlassianConnectionId?: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Puts the user on the “wait for install” screen immediately (e.g. Storybook).
   * No effect unless the user is past Link Atlassian and Forge is not installed yet.
   */
  initialWaitForInstall?: boolean
}

export function ConfluenceSetupWizard({
  orgSlug,
  atlassianConnectionId,
  isOpen,
  onOpenChange,
  initialWaitForInstall = false,
}: ConfluenceSetupWizardProps) {
  const [waitForInstall, setWaitForInstall] = useState(initialWaitForInstall)
  // A save always opens pull requests: the wizard then shows the merge step.
  const [pullRequests, setPullRequests] = useState<OpenedPullRequest[]>([])
  const workspacesDone = pullRequests.length > 0
  const [manualStepIndex, setManualStepIndex] = useState<number | null>(null)
  const prevServerStepIndexRef = useRef<number | null>(null)
  const queryClient = useQueryClient()
  const statusKey = atlassianConnectorKeys.status(
    orgSlug,
    atlassianConnectionId,
  )

  const {
    data: status,
    isPending: statusPending,
    isError: statusError,
    refetch: refetchStatus,
  } = useQuery({
    queryKey: statusKey,
    queryFn: async () => {
      const previous =
        queryClient.getQueryData<AtlassianConnectorStatus>(statusKey)
      const next = await fetchAtlassianConnectorStatus(
        orgSlug,
        atlassianConnectionId,
      )
      if (
        waitForInstall &&
        previous &&
        !previous.isInstalled &&
        next.isInstalled
      ) {
        HyperDX.addAction("connector_connect", { connector: "forge" })
      }
      return next
    },
    placeholderData: keepPreviousData,
    enabled: isOpen,
    staleTime: 0,
    refetchOnWindowFocus: "always",
    refetchIntervalInBackground: true,
    refetchInterval: (query) => {
      if (query.state.status === "error") return false
      const data = query.state.data as AtlassianConnectorStatus | undefined
      if (!isOpen) return false
      if (waitForInstall && data && !data.isInstalled) {
        return pollWhileOk(3000)(query)
      }
      return false
    },
  })

  const {
    data: orgOauthData,
    isPending: orgOauthPending,
    isSuccess: orgOauthSuccess,
  } = useQuery({
    queryKey: atlassianConnectorKeys.orgAtlassianOauth(
      orgSlug,
      atlassianConnectionId ?? "",
    ),
    queryFn: () => {
      if (!atlassianConnectionId) {
        throw new Error("Confluence wizard requires connectionId")
      }
      return fetchOrgAtlassianOauth(orgSlug, atlassianConnectionId)
    },
    enabled: Boolean(isOpen && atlassianConnectionId),
  })

  const oauthForModel =
    atlassianConnectionId && orgOauthSuccess ? orgOauthData : undefined

  const wizardStepDefs = getConfluenceCardStepDefs(oauthForModel)

  const cardIndexForStepper =
    status && !statusPending
      ? getConfluenceCardCurrentIndex(status, oauthForModel)
      : 0

  useEffect(() => {
    if (statusPending || !status) return
    const idx = getConfluenceCardCurrentIndex(status, oauthForModel)
    if (
      prevServerStepIndexRef.current !== null &&
      idx > prevServerStepIndexRef.current
    ) {
      setManualStepIndex(null)
    }
    prevServerStepIndexRef.current = idx
  }, [statusPending, status, oauthForModel])

  const orgOauthBlocking = Boolean(atlassianConnectionId) && orgOauthPending

  const effectiveManual =
    manualStepIndex != null && manualStepIndex < cardIndexForStepper
      ? manualStepIndex
      : null

  /** User opened the Forge install flow; show wait UI + poll only while status still says not installed. */
  const waitForInstallMode =
    status != null && waitForInstall && !status.isInstalled

  const bodyId =
    status != null
      ? effectiveManual != null
        ? getConfluenceWizardBodyIdForStepIndex(
            effectiveManual,
            status,
            {
              waitForInstall: waitForInstallMode,
            },
            oauthForModel,
          )
        : getConfluenceWizardBodyId(
            status,
            {
              waitForInstall: waitForInstallMode,
              workspacesDone,
            },
            oauthForModel,
          )
      : ("link" as const)

  // Closing the setup asks the server to delete an empty draft, so a
  // canceled "Add Confluence" leaves no connector entry. The server keeps a
  // draft with progress, also one whose Forge install the user opened: the
  // Marketplace can still bind that install to it.
  const cancelSetup = useMutation({
    mutationFn: (connectionId: string) =>
      cancelAtlassianSetup(orgSlug, connectionId),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      }),
  })
  const close = () => {
    if (atlassianConnectionId && !status?.isInstalled)
      cancelSetup.mutate(atlassianConnectionId)
    setWaitForInstall(false)
    setPullRequests([])
    setManualStepIndex(null)
    prevServerStepIndexRef.current = null
    onOpenChange(false)
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => (open ? onOpenChange(true) : close())}
      isDismissable
      className="max-w-[min(92vw,720px)]"
    >
      <div className="p-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            <span className="ctx-node h-9 w-9">
              <ConfluenceMark
                className="size-5 text-foreground"
                variant="outline"
              />
            </span>
            <div>
              <h2 className="text-lg font-medium tracking-tight text-foreground">
                Set up Confluence connector
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Connect Confluence, then select the spaces and pages for each
                Workspace.
              </p>
            </div>
          </div>
          <Button variant="secondary" className="rounded-md" onPress={close}>
            Close
          </Button>
        </div>

        {status && !statusPending && !orgOauthBlocking ? (
          <div className="mb-6">
            <ConnectorSetupStepper
              steps={wizardStepDefs}
              currentIndex={
                workspacesDone ? wizardStepDefs.length : cardIndexForStepper
              }
              focusOverride={effectiveManual}
              onStepSelect={(i) => {
                if (i === cardIndexForStepper && manualStepIndex != null) {
                  setManualStepIndex(null)
                  return
                }
                if (i >= cardIndexForStepper) return
                if (wizardStepDefs[i]?.id === "forge") {
                  setWaitForInstall(false)
                }
                setManualStepIndex(i)
              }}
            />
          </div>
        ) : null}

        {statusPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Loading…
          </div>
        ) : statusError ? (
          <div className="mt-6 space-y-3 text-sm text-muted-foreground">
            <p className="text-destructive">Could not load connector status.</p>
            <Button
              variant="secondary"
              className="rounded-md"
              onPress={() => void refetchStatus()}
            >
              Retry
            </Button>
          </div>
        ) : !status ? (
          <p className="mt-6 text-sm text-muted-foreground">
            Connector status is unavailable. Try closing and opening this dialog
            again.
          </p>
        ) : orgOauthBlocking ? (
          <div className="mt-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner className="text-muted-foreground" />
            Loading OAuth settings...
          </div>
        ) : (
          <div className="mt-2">
            {bodyId === "oauth_register" && atlassianConnectionId ? (
              <RegisterAtlassianOauthStep
                orgSlug={orgSlug}
                atlassianConnectionId={atlassianConnectionId}
              />
            ) : null}
            {bodyId === "oauth_register" && !atlassianConnectionId ? (
              <p className="text-sm text-destructive">
                Missing connection. Close this dialog and open setup from the
                Confluence connector card.
              </p>
            ) : null}
            {bodyId === "link" && atlassianConnectionId ? (
              <LinkAtlassianStep
                orgSlug={orgSlug}
                atlassianConnectionId={atlassianConnectionId}
              />
            ) : null}
            {bodyId === "link" && !atlassianConnectionId ? (
              <p className="text-sm text-destructive">
                Missing connection. Close this dialog and open setup from the
                Confluence connector card.
              </p>
            ) : null}
            {bodyId === "install" && atlassianConnectionId ? (
              <InstallForgeStep
                orgSlug={orgSlug}
                atlassianConnectionId={atlassianConnectionId}
                onOpenedInstall={() => {
                  setWaitForInstall(true)
                  void refetchStatus()
                }}
              />
            ) : null}
            {bodyId === "install" && !atlassianConnectionId ? (
              <p className="text-sm text-destructive">
                Missing connection. Close this dialog and open setup from the
                Confluence connector card.
              </p>
            ) : null}
            {bodyId === "wait" ? <WaitForInstallStep /> : null}
            {bodyId === "workspaces" && atlassianConnectionId ? (
              <AddToWorkspacesStep
                orgSlug={orgSlug}
                provider="confluence"
                connectionId={atlassianConnectionId}
                label="Confluence"
                description="the spaces and pages for each"
                items="the spaces"
                replacedConfigPullUrl={status.pendingConfigPullUrl}
                onDone={(opened) => {
                  setManualStepIndex(null)
                  setPullRequests(opened)
                }}
              />
            ) : null}
            {bodyId === "workspaces" && !atlassianConnectionId ? (
              <p className="text-sm text-destructive">
                Missing connection. Close this dialog and open setup from the
                Confluence connector card.
              </p>
            ) : null}
            {bodyId === "complete" ? (
              <div className="space-y-4">
                <PullRequestsToMerge
                  orgSlug={orgSlug}
                  pullRequests={pullRequests}
                />
                <Button
                  variant="secondary"
                  className="rounded-md"
                  onPress={close}
                >
                  Close
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  )
}
