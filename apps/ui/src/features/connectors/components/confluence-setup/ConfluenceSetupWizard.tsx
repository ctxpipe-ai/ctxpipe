"use client"

import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import {
  getConfluenceCardCurrentIndex,
  getConfluenceCardStepDefs,
  getConfluenceWizardBodyId,
  getConfluenceWizardBodyIdForStepIndex,
} from "../../confluence-setup-model"
import { EditScopeModal } from "../../EditScopeModal"
import {
  atlassianConnectorKeys,
  fetchAtlassianConnectorStatus,
  fetchOrgAtlassianOauth,
} from "../../queries/atlassian-connector"
import type { AtlassianConnectorStatus } from "../../types"
import { ConfluenceStepper } from "../ConfluenceStepper"
import { InstallForgeStep } from "./steps/InstallForgeStep"
import { LinkAtlassianStep } from "./steps/LinkAtlassianStep"
import { LinkGitHubStep } from "./steps/LinkGitHubStep"
import { MergeConfigStep } from "./steps/MergeConfigStep"
import { RegisterAtlassianOauthStep } from "./steps/RegisterAtlassianOauthStep"
import { SelectSyncTargetStep } from "./steps/SelectSyncTargetStep"
import { SetupCompleteStep } from "./steps/SetupCompleteStep"
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
  const [manualStepIndex, setManualStepIndex] = useState<number | null>(null)
  const prevServerStepIndexRef = useRef<number | null>(null)

  const {
    data: status,
    isPending: statusPending,
    isError: statusError,
    refetch: refetchStatus,
  } = useQuery({
    queryKey: atlassianConnectorKeys.status(orgSlug, atlassianConnectionId),
    queryFn: () =>
      fetchAtlassianConnectorStatus(orgSlug, atlassianConnectionId),
    placeholderData: keepPreviousData,
    enabled: isOpen,
    refetchInterval: (query) => {
      const data = query.state.data as AtlassianConnectorStatus | undefined
      if (!isOpen) return false
      if (waitForInstall && data && !data.isInstalled) return 3000
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
            },
            oauthForModel,
          )
      : ("link" as const)

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          setWaitForInstall(false)
          setManualStepIndex(null)
          prevServerStepIndexRef.current = null
        }
        onOpenChange(open)
      }}
      isDismissable
      size="wide"
    >
      <div className="px-6 py-5">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">
              Set up Atlassian connector
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              Complete each step to connect Confluence content to this
              organization.
            </p>
          </div>
          <Button variant="secondary" onPress={() => onOpenChange(false)}>
            Close
          </Button>
        </div>

        {status && !statusPending && !orgOauthBlocking ? (
          <div className="mb-6">
            <ConfluenceStepper
              steps={wizardStepDefs}
              currentIndex={cardIndexForStepper}
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
          <div className="mt-8 flex items-center justify-center gap-2 text-sm text-zinc-300">
            <Spinner className="text-zinc-400" />
            Loading connector status...
          </div>
        ) : statusError ? (
          <div className="mt-6 space-y-3 text-sm text-zinc-300">
            <p className="text-red-400">Could not load connector status.</p>
            <Button variant="secondary" onPress={() => void refetchStatus()}>
              Retry
            </Button>
          </div>
        ) : !status ? (
          <p className="mt-6 text-sm text-zinc-400">
            Connector status is unavailable. Try closing and opening this dialog
            again.
          </p>
        ) : orgOauthBlocking ? (
          <div className="mt-8 flex items-center justify-center gap-2 text-sm text-zinc-300">
            <Spinner className="text-zinc-400" />
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
              <p className="text-sm text-red-400">
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
              <p className="text-sm text-red-400">
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
              <p className="text-sm text-red-400">
                Missing connection. Close this dialog and open setup from the
                Confluence connector card.
              </p>
            ) : null}
            {bodyId === "wait" ? <WaitForInstallStep /> : null}
            {bodyId === "github" ? (
              <LinkGitHubStep
                orgSlug={orgSlug}
                onConnected={async () => {
                  await refetchStatus()
                }}
              />
            ) : null}
            {bodyId === "target" ? (
              <SelectSyncTargetStep
                orgSlug={orgSlug}
                atlassianConnectionId={atlassianConnectionId}
              />
            ) : null}
            {bodyId === "scope" && atlassianConnectionId ? (
              <EditScopeModal
                embedded
                orgSlug={orgSlug}
                atlassianConnectionId={atlassianConnectionId}
                onClose={() => onOpenChange(false)}
                onSuccessfulSave={async () => {
                  await refetchStatus()
                }}
              />
            ) : null}
            {bodyId === "scope" && !atlassianConnectionId ? (
              <p className="text-sm text-red-400">
                Missing connection. Close this dialog and open setup from the
                Confluence connector card.
              </p>
            ) : null}
            {bodyId === "merge" && atlassianConnectionId ? (
              <MergeConfigStep
                orgSlug={orgSlug}
                atlassianConnectionId={atlassianConnectionId}
              />
            ) : null}
            {bodyId === "merge" && !atlassianConnectionId ? (
              <p className="text-sm text-red-400">
                Missing connection. Close this dialog and open setup from the
                Confluence connector card.
              </p>
            ) : null}
            {bodyId === "complete" ? (
              <SetupCompleteStep onClose={() => onOpenChange(false)} />
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  )
}
