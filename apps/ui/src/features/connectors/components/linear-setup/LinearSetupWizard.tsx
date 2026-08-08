"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import {
  getLinearSetupCurrentIndex,
  getLinearWizardBodyId,
  LINEAR_SETUP_STEPS,
} from "../../linear-setup-model"
import {
  fetchLinearConnectorStatus,
  type LinearConnectorStatus,
  linearConnectorKeys,
} from "../../queries/linear-connector"
import { ConnectorSetupStepper } from "../ConnectorSetupStepper"
import { GithubPrerequisiteStep } from "../GithubPrerequisiteStep"
import { LinearMark } from "../LinearMark"
import { LinearConnectStep } from "./LinearConnectStep"
import { LinearMergeStep } from "./LinearMergeStep"
import { LinearScopeStep } from "./LinearScopeStep"
import { LinearTargetStep } from "./LinearTargetStep"

type LinearSetupWizardProps = {
  orgSlug: string
  connectionId?: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onConnectionIdChange: (connectionId: string) => void
}

export function LinearSetupWizard({
  orgSlug,
  connectionId,
  isOpen,
  onOpenChange,
  onConnectionIdChange,
}: LinearSetupWizardProps) {
  const queryClient = useQueryClient()
  const [manualScope, setManualScope] = useState(false)
  const [manualStepIndex, setManualStepIndex] = useState<number | null>(null)
  const previousServerStepIndexRef = useRef<number | null>(null)
  const statusQuery = useQuery({
    queryKey: linearConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchLinearConnectorStatus(orgSlug, connectionId),
    enabled: isOpen && Boolean(connectionId),
    refetchInterval: (query) => {
      if (!isOpen) return false
      const status = query.state.data as LinearConnectorStatus | undefined
      if (
        status?.pendingConfigPrCreating ||
        status?.setupPhase === "awaiting_merge" ||
        status?.setupPhase === "initial_sync"
      ) {
        return 2000
      }
      return false
    },
  })

  useEffect(() => {
    if (!isOpen) return
    const acceptResult = (value: unknown) => {
      if (!value || typeof value !== "object") return
      const data = value as Record<string, unknown>
      if (
        data.type === "linear-oauth-error" &&
        data.orgSlug === orgSlug &&
        typeof data.error === "string"
      ) {
        toast.error(data.error)
        return
      }
      if (
        data.type !== "linear-oauth-complete" ||
        data.orgSlug !== orgSlug ||
        typeof data.connectionId !== "string"
      ) {
        return
      }
      onConnectionIdChange(data.connectionId)
      void queryClient.invalidateQueries({
        queryKey: linearConnectorKeys.allStatusForOrg(orgSlug),
      })
    }
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) return
      acceptResult(event.data)
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "linear-setup-result" || !event.newValue) return
      try {
        acceptResult(JSON.parse(event.newValue) as unknown)
      } catch {
        // The signed OAuth callback is the only writer; ignore malformed values.
      } finally {
        window.localStorage.removeItem("linear-setup-result")
      }
    }
    const storedResult = window.localStorage.getItem("linear-setup-result")
    if (storedResult) {
      try {
        acceptResult(JSON.parse(storedResult) as unknown)
      } catch {
        // The signed OAuth callback is the only writer; ignore malformed values.
      } finally {
        window.localStorage.removeItem("linear-setup-result")
      }
    }
    window.addEventListener("message", handleMessage)
    window.addEventListener("storage", handleStorage)
    return () => {
      window.removeEventListener("message", handleMessage)
      window.removeEventListener("storage", handleStorage)
    }
  }, [isOpen, onConnectionIdChange, orgSlug, queryClient])

  const status: LinearConnectorStatus | undefined = connectionId
    ? statusQuery.data
    : {
        isInstalled: false,
        installationStatus: null,
        workspaceName: null,
        isGithubLinked: false,
        selectedScopeCount: 0,
        setupPhase: "draft",
        pendingConfigPullUrl: null,
        pendingConfigPrCreating: false,
        syncTarget: null,
      }
  const currentIndex = status ? getLinearSetupCurrentIndex(status) : 0
  const effectiveManualStepIndex =
    manualStepIndex != null && manualStepIndex < currentIndex
      ? manualStepIndex
      : null
  const serverBody = status ? getLinearWizardBodyId(status) : "connect"
  const manualBody =
    effectiveManualStepIndex == null
      ? null
      : (LINEAR_SETUP_STEPS[effectiveManualStepIndex]?.id ?? null)
  const body = manualScope ? "scope" : (manualBody ?? serverBody)
  const requireConnection = connectionId && status?.isInstalled
  const closeWizard = () => {
    setManualScope(false)
    setManualStepIndex(null)
    onOpenChange(false)
  }

  useEffect(() => {
    if (!status || statusQuery.isPending) return
    if (
      previousServerStepIndexRef.current !== null &&
      currentIndex > previousServerStepIndexRef.current
    ) {
      setManualStepIndex(null)
    }
    previousServerStepIndexRef.current = currentIndex
  }, [currentIndex, status, statusQuery.isPending])

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          setManualScope(false)
          setManualStepIndex(null)
          previousServerStepIndexRef.current = null
        }
        onOpenChange(open)
      }}
      isDismissable
      className="max-w-[min(92vw,720px)]"
    >
      <div className="p-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            <span className="ctx-node h-9 w-9">
              <LinearMark className="size-5 text-foreground" />
            </span>
            <div>
              <h2 className="text-lg font-medium tracking-tight text-foreground">
                Set up Linear connector
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Authorise Linear, choose Git scope, then approve the generated
                configuration.
              </p>
            </div>
          </div>
          <Button
            variant="secondary"
            className="rounded-none"
            onPress={closeWizard}
          >
            Close
          </Button>
        </div>

        {status && !statusQuery.isPending ? (
          <div className="mb-6">
            <ConnectorSetupStepper
              steps={LINEAR_SETUP_STEPS}
              currentIndex={currentIndex}
              focusOverride={effectiveManualStepIndex}
              onStepSelect={(index) => {
                if (
                  status.pendingConfigPrCreating ||
                  status.setupPhase === "initial_sync"
                ) {
                  return
                }
                if (index === currentIndex && manualStepIndex != null) {
                  setManualStepIndex(null)
                  return
                }
                if (index >= currentIndex) return
                setManualStepIndex(index)
              }}
            />
          </div>
        ) : null}

        {connectionId && statusQuery.isPending ? (
          <div className="mt-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Loading connector status...
          </div>
        ) : connectionId && statusQuery.isError ? (
          <div className="space-y-3 text-sm">
            <p className="text-destructive">
              Could not load Linear connector status.
            </p>
            <Button
              variant="secondary"
              className="rounded-none"
              onPress={() => void statusQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : status ? (
          <div className="mt-2">
            {body === "connect" ? (
              <LinearConnectStep orgSlug={orgSlug} />
            ) : null}
            {body === "github" ? (
              <GithubPrerequisiteStep orgSlug={orgSlug} sourceName="Linear" />
            ) : null}
            {body === "target" && requireConnection ? (
              <LinearTargetStep
                orgSlug={orgSlug}
                connectionId={connectionId}
                onBack={() =>
                  setManualStepIndex(
                    LINEAR_SETUP_STEPS.findIndex(
                      (step) => step.id === "github",
                    ),
                  )
                }
                onSaved={async () => {
                  setManualStepIndex(null)
                  return statusQuery.refetch()
                }}
              />
            ) : null}
            {body === "scope" && requireConnection ? (
              <LinearScopeStep
                orgSlug={orgSlug}
                connectionId={connectionId}
                onBack={() => {
                  setManualScope(false)
                  setManualStepIndex(
                    LINEAR_SETUP_STEPS.findIndex(
                      (step) => step.id === "target",
                    ),
                  )
                }}
                onSaved={async () => {
                  setManualScope(false)
                  setManualStepIndex(null)
                  return statusQuery.refetch()
                }}
              />
            ) : null}
            {body === "merge" && requireConnection ? (
              <LinearMergeStep
                orgSlug={orgSlug}
                connectionId={connectionId}
                status={status}
                onRetry={statusQuery.refetch}
              />
            ) : null}
            {body === "complete" ? (
              <div className="space-y-4">
                <div>
                  <h3 className="text-base font-semibold text-foreground">
                    Linear is connected
                  </h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Content is synchronised through{" "}
                    <code className="rounded-none bg-muted px-1 py-0.5 text-xs">
                      linear/config.yaml
                    </code>
                    . Change scope at any time; updates remain reviewable in
                    GitHub.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    className="rounded-none"
                    onPress={() => setManualScope(true)}
                  >
                    Manage scope
                  </Button>
                  <Button
                    variant="secondary"
                    className="rounded-none"
                    onPress={closeWizard}
                  >
                    Close
                  </Button>
                </div>
              </div>
            ) : null}
            {body !== "connect" && !requireConnection ? (
              <p className="text-sm text-destructive">
                The Linear connection identifier is missing. Close this dialog
                and reopen setup from the connector card.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
