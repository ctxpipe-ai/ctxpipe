"use client"

import { useQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import {
  getConfluenceCardCurrentIndex,
  getConfluenceWizardBodyId,
  getConfluenceWizardBodyIdForStepIndex,
} from "../../confluence-setup-model"
import {
  atlassianConnectorKeys,
  fetchAtlassianConnectorStatus,
} from "../../queries/atlassian-connector"
import type { AtlassianConnectorStatus } from "../../types"
import { ConfluenceStepper } from "../ConfluenceStepper"
import { InstallForgeStep } from "./steps/InstallForgeStep"
import { InstallSuccessStep } from "./steps/InstallSuccessStep"
import { LinkAtlassianStep } from "./steps/LinkAtlassianStep"
import { LinkGitHubStep } from "./steps/LinkGitHubStep"
import { SelectSyncTargetStep } from "./steps/SelectSyncTargetStep"
import { SetupCompleteStep } from "./steps/SetupCompleteStep"
import { WaitForInstallStep } from "./steps/WaitForInstallStep"

type ConfluenceSetupWizardProps = {
  orgSlug: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

export function ConfluenceSetupWizard({
  orgSlug,
  isOpen,
  onOpenChange,
}: ConfluenceSetupWizardProps) {
  const [waitForInstall, setWaitForInstall] = useState(false)
  const [showInstallSuccess, setShowInstallSuccess] = useState(false)
  const [hasShownInstallSuccess, setHasShownInstallSuccess] = useState(false)
  const [manualStepIndex, setManualStepIndex] = useState<number | null>(null)
  const prevServerStepIndexRef = useRef<number | null>(null)

  const {
    data: status,
    isPending: statusPending,
    isError: statusError,
    refetch: refetchStatus,
  } = useQuery({
    queryKey: atlassianConnectorKeys.status(orgSlug),
    queryFn: () => fetchAtlassianConnectorStatus(orgSlug),
    enabled: isOpen,
    refetchInterval: (query) => {
      const data = query.state.data as AtlassianConnectorStatus | undefined
      if (!isOpen) return false
      if (!waitForInstall) return false
      return data?.isInstalled ? false : 3000
    },
  })

  useEffect(() => {
    if (status?.syncTargetConfigured) {
      setShowInstallSuccess(false)
    }
  }, [status?.syncTargetConfigured])

  useEffect(() => {
    if (status?.isInstalled) {
      setWaitForInstall(false)
      if (!hasShownInstallSuccess && !status.syncTargetConfigured) {
        setShowInstallSuccess(true)
        setHasShownInstallSuccess(true)
      }
    }
  }, [
    status?.isInstalled,
    status?.syncTargetConfigured,
    hasShownInstallSuccess,
  ])

  useEffect(() => {
    if (!isOpen) {
      setWaitForInstall(false)
      setShowInstallSuccess(false)
      setManualStepIndex(null)
      prevServerStepIndexRef.current = null
    }
  }, [isOpen])

  const cardIndexForStepper =
    status && !statusPending ? getConfluenceCardCurrentIndex(status) : 0

  useEffect(() => {
    if (statusPending || !status) return
    const idx = getConfluenceCardCurrentIndex(status)
    if (
      prevServerStepIndexRef.current !== null &&
      idx > prevServerStepIndexRef.current
    ) {
      setManualStepIndex(null)
    }
    prevServerStepIndexRef.current = idx
  }, [statusPending, status])

  const effectiveManual =
    manualStepIndex != null && manualStepIndex < cardIndexForStepper
      ? manualStepIndex
      : null

  const bodyId =
    status != null
      ? effectiveManual != null
        ? getConfluenceWizardBodyIdForStepIndex(effectiveManual, status, {
            waitForInstall,
            showInstallSuccess,
          })
        : getConfluenceWizardBodyId(status, {
            waitForInstall,
            showInstallSuccess,
          })
      : ("link" as const)

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
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

        {status && !statusPending ? (
          <div className="mb-6">
            <ConfluenceStepper
              currentIndex={cardIndexForStepper}
              focusOverride={effectiveManual}
              onStepSelect={(i) => {
                if (i === cardIndexForStepper && manualStepIndex != null) {
                  setManualStepIndex(null)
                  return
                }
                if (i >= cardIndexForStepper) return
                if (i === 1) {
                  setWaitForInstall(false)
                  setShowInstallSuccess(false)
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
        ) : (
          <div className="mt-2">
            {bodyId === "link" ? <LinkAtlassianStep /> : null}
            {bodyId === "install" ? (
              <InstallForgeStep
                orgSlug={orgSlug}
                onOpenedInstall={() => {
                  setWaitForInstall(true)
                  void refetchStatus()
                }}
              />
            ) : null}
            {bodyId === "wait" ? <WaitForInstallStep /> : null}
            {bodyId === "install_success" ? (
              <InstallSuccessStep
                onContinue={() => setShowInstallSuccess(false)}
              />
            ) : null}
            {bodyId === "github" ? <LinkGitHubStep orgSlug={orgSlug} /> : null}
            {bodyId === "target" ? (
              <SelectSyncTargetStep orgSlug={orgSlug} />
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
