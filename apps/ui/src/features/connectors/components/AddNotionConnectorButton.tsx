"use client"

import { IconBrandNotion } from "@tabler/icons-react"
import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { Spinner } from "@/components/ui/spinner"
import { useNotionOAuthConnect } from "../hooks/useNotionOAuthConnect"
import {
  createDraftNotionConnection,
  fetchNotionOauthApp,
} from "../queries/notion-connector"
import { orgConnectionsKeys } from "../queries/org-connections"

export type AddNotionConnectorButtonProps = {
  orgSlug: string
  onFlowStarted?: () => void
  onFlowFinished?: (result: { connectionId?: string }) => void
  onRegisterRequired?: (result: { connectionId: string }) => void
  onConfigurationRequired?: () => void
}

export function AddNotionConnectorButton({
  orgSlug,
  onFlowStarted,
  onFlowFinished,
  onRegisterRequired,
  onConfigurationRequired,
}: AddNotionConnectorButtonProps) {
  const queryClient = useQueryClient()
  const oauth = useNotionOAuthConnect(orgSlug)
  const [creating, setCreating] = useState(false)
  const busy = creating || oauth.busy

  const handleClick = async () => {
    onFlowStarted?.()
    setCreating(true)
    try {
      const draft = await createDraftNotionConnection(orgSlug)
      await queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
      const oauthApp = await fetchNotionOauthApp(orgSlug, draft.id)
      if (
        !oauthApp.globalNotionOAuthConfigured &&
        !oauthApp.oauthAppSaved
      ) {
        onRegisterRequired?.({ connectionId: draft.id })
        return
      }
      oauth.start({
        connectionId: draft.id,
        onFinished: (result) => {
          onFlowFinished?.(result)
        },
        onConfigurationRequired,
      })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to connect Notion",
      )
      onFlowFinished?.({})
    } finally {
      setCreating(false)
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
