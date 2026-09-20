import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
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

export function useNotionOAuthConnect(orgSlug: string) {
  const queryClient = useQueryClient()
  const watchPopupClose = useWatchPopupClose()
  const [busy, setBusy] = useState(false)

  const finish = async (): Promise<{ connectionId?: string }> => {
    const result = consumeNotionSetupPopupResult()
    if (result.status === "error") {
      toast.error(result.error)
      return {}
    }
    await queryClient.invalidateQueries({
      queryKey: orgConnectionsKeys.list(orgSlug),
    })
    const items = await queryClient.fetchQuery({
      queryKey: orgConnectionsKeys.list(orgSlug),
      queryFn: () => fetchOrgConnections(orgSlug),
    })
    if (result.status === "connected") {
      return { connectionId: result.connectionId }
    }
    const latestNotion = items
      .filter((item) => item.type === "notion")
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )[0]
    return { connectionId: latestNotion?.id }
  }

  const start = (input: {
    connectionId: string
    onFinished: (result: { connectionId?: string }) => void
    onConfigurationRequired?: () => void
  }) => {
    setBusy(true)
    void (async () => {
      try {
        const { authorizationUrl } = await fetchNotionOAuthStart(
          orgSlug,
          input.connectionId,
        )
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
          void finish().then(input.onFinished)
        }
        const handleStorage = (event: StorageEvent) => {
          if (event.key !== NOTION_SETUP_RESULT_KEY) return
          popup.close()
          handleFinished()
        }
        window.addEventListener("storage", handleStorage)
        watchPopupClose(popup, handleFinished)
      } catch (error) {
        setBusy(false)
        if (error instanceof NotionOAuthNotConfiguredError) {
          input.onConfigurationRequired?.()
          return
        }
        toast.error(
          error instanceof Error ? error.message : "Failed to connect Notion",
        )
        input.onFinished({})
      }
    })()
  }

  return { start, busy }
}
