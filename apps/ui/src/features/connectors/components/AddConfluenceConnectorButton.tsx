"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Spinner } from "@/components/ui/spinner"
import { registerAtlassianInstallIntent } from "../queries/atlassian-connector"
import { orgConnectionsKeys } from "../queries/org-connections"
import { ConfluenceMark } from "./ConfluenceMark"

export type AddConfluenceConnectorButtonProps = {
  orgSlug: string
  /** After the pending connection row exists and org connections are invalidated. */
  onInstallIntentRegistered: (args: { connectionId: string }) => void
}

export function AddConfluenceConnectorButton({
  orgSlug,
  onInstallIntentRegistered,
}: AddConfluenceConnectorButtonProps) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => registerAtlassianInstallIntent(orgSlug),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
      onInstallIntentRegistered({ connectionId: data.id })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <button
      type="button"
      disabled={mutation.isPending}
      className="group flex w-full items-start gap-4 rounded-none border border-border bg-card/40 p-4 text-left outline-none transition-colors hover:border-teal-400/40 hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-wait disabled:opacity-60"
      onClick={() => {
        void mutation.mutateAsync()
      }}
    >
      <span className="ctx-node size-12 transition-colors group-hover:border-teal-400/60 group-hover:bg-teal-400/5">
        <ConfluenceMark className="size-7" />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 font-medium text-foreground">
          Atlassian Confluence
          {mutation.isPending ? (
            <Spinner className="size-4 text-muted-foreground" aria-hidden />
          ) : null}
        </span>
        <span className="mt-1 block text-sm text-muted-foreground">
          Sync spaces and pages from Confluence into ctxpipe and your linked Git
          repositories.
        </span>
      </span>
    </button>
  )
}
