"use client"

import { IconBrandNotion } from "@tabler/icons-react"
import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { Spinner } from "@/components/ui/spinner"
import {
  consumeNotionSetupPopupResult,
  NOTION_POPUP_NAME,
  NOTION_SETUP_RESULT_KEY,
  openCenteredPopup,
  useWatchPopupClose,
} from "@/lib/popup"
import {
  fetchNotionOAuthStart,
  NotionOAuthNotConfiguredError,
} from "../queries/notion-connector"
import {
  fetchOrgConnections,
  orgConnectionsKeys,
} from "../queries/org-connections"

export type AddNotionConnectorButtonProps = {
  orgSlug: string
  onFlowStarted?: () => void
  onFlowFinished?: (result: { connectionId?: string }) => void
  onConfigurationRequired?: () => void
}

export function AddNotionConnectorButton({
  orgSlug,
  onFlowStarted,
  onFlowFinished,
  onConfigurationRequired,
}: AddNotionConnectorButtonProps) {
  const queryClient = useQueryClient()
  const watchPopupClose = useWatchPopupClose()
  const [busy, setBusy] = useState(false)

  const finishFlow = async () => {
    try {
      const result = consumeNotionSetupPopupResult()
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
      const latestNotion = items
        .filter((item) => item.type === "notion")
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )[0]
      onFlowFinished?.({ connectionId: latestNotion?.id })
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to refresh connectors",
      )
      onFlowFinished?.({})
    }
  }

  const handleClick = async () => {
    onFlowStarted?.()
    setBusy(true)
    try {
      const { authorizationUrl } = await fetchNotionOAuthStart(orgSlug)
      const popup = openCenteredPopup(authorizationUrl, {
        name: NOTION_POPUP_NAME,
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
        if (event.key !== NOTION_SETUP_RESULT_KEY) return
        popup.close()
        handleFinished()
      }
      window.addEventListener("storage", handleStorage)
      watchPopupClose(popup, () => {
        handleFinished()
      })
    } catch (e) {
      setBusy(false)
      if (e instanceof NotionOAuthNotConfiguredError) {
        onConfigurationRequired?.()
        return
      }
      toast.error(e instanceof Error ? e.message : "Failed to connect Notion")
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
        <IconBrandNotion className="size-6 text-foreground" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 font-medium text-foreground">
          Notion
          {busy ? (
            <Spinner className="size-4 text-muted-foreground" aria-hidden />
          ) : null}
        </span>
        <span className="mt-1 block text-sm text-muted-foreground">
          Sync product decisions, specs, and docs from selected Notion pages.
        </span>
      </span>
    </button>
  )
}
