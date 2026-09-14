"use client"

import { IconAlertTriangle } from "@tabler/icons-react"
import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { Spinner } from "@/components/ui/spinner"
import {
  consumePagerdutySetupPopupResult,
  openCenteredPopup,
  PAGERDUTY_POPUP_NAME,
  PAGERDUTY_SETUP_RESULT_KEY,
  useWatchPopupClose,
} from "@/lib/popup"
import {
  fetchOrgConnections,
  orgConnectionsKeys,
} from "../queries/org-connections"
import {
  fetchPagerdutyOAuthStart,
  PagerdutyOAuthNotConfiguredError,
} from "../queries/pagerduty-connector"

export type AddPagerdutyConnectorButtonProps = {
  orgSlug: string
  onFlowStarted?: () => void
  onFlowFinished?: (result: { connectionId?: string }) => void
  onConfigurationRequired?: () => void
}

export function AddPagerdutyConnectorButton({
  orgSlug,
  onFlowStarted,
  onFlowFinished,
  onConfigurationRequired,
}: AddPagerdutyConnectorButtonProps) {
  const queryClient = useQueryClient()
  const watchPopupClose = useWatchPopupClose()
  const [busy, setBusy] = useState(false)

  const finishFlow = async () => {
    try {
      const result = consumePagerdutySetupPopupResult()
      if (result.status === "error") {
        toast.error(result.error)
        onFlowFinished?.({})
        return
      }
      await queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
      const items = await queryClient.fetchQuery({
        queryKey: orgConnectionsKeys.list(orgSlug),
        queryFn: () => fetchOrgConnections(orgSlug),
      })
      if (result.status === "connected") {
        onFlowFinished?.({ connectionId: result.connectionId })
        return
      }
      const latest = items
        .filter((item) => item.type === "pagerduty")
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )[0]
      onFlowFinished?.({ connectionId: latest?.id })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to refresh connectors",
      )
      onFlowFinished?.({})
    }
  }

  const handleClick = async () => {
    onFlowStarted?.()
    setBusy(true)
    try {
      const { authorizationUrl } = await fetchPagerdutyOAuthStart(orgSlug)
      const popup = openCenteredPopup(authorizationUrl, {
        name: PAGERDUTY_POPUP_NAME,
        width: 1120,
        height: 780,
      })
      if (!popup) {
        setBusy(false)
        return
      }
      let handled = false
      const handleFinished = () => {
        if (handled) return
        handled = true
        window.removeEventListener("storage", handleStorage)
        setBusy(false)
        void finishFlow()
      }
      const handleStorage = (event: StorageEvent) => {
        if (event.key !== PAGERDUTY_SETUP_RESULT_KEY) return
        popup.close()
        handleFinished()
      }
      window.addEventListener("storage", handleStorage)
      watchPopupClose(popup, () => {
        handleFinished()
      })
    } catch (error) {
      setBusy(false)
      if (error instanceof PagerdutyOAuthNotConfiguredError) {
        if (onConfigurationRequired) {
          onConfigurationRequired()
          return
        }
        toast.error(error.message)
        return
      }
      toast.error(
        error instanceof Error ? error.message : "Failed to connect PagerDuty",
      )
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      className="group flex w-full items-start gap-4 rounded-none border border-border bg-card/40 p-4 text-left outline-none transition-colors hover:border-teal-400/40 hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-wait disabled:opacity-60"
      onClick={() => void handleClick()}
    >
      <span className="ctx-node size-12 transition-colors group-hover:border-teal-400/60 group-hover:bg-teal-400/5">
        <IconAlertTriangle className="size-6 text-foreground" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 font-medium text-foreground">
          PagerDuty
          {busy ? (
            <Spinner className="size-4 text-muted-foreground" aria-hidden />
          ) : null}
        </span>
        <span className="mt-1 block text-sm text-muted-foreground">
          Mirror selected incident and alert context into a linked Git
          repository.
        </span>
      </span>
    </button>
  )
}
