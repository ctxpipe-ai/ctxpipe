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
      className="flex w-full items-start gap-4 rounded-none border border-zinc-800 bg-zinc-900/40 p-4 text-left outline-none transition hover:border-zinc-700 hover:bg-zinc-900/70 focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-wait disabled:opacity-60"
      onClick={() => {
        void mutation.mutateAsync()
      }}
    >
      <ConfluenceMark className="size-12 shrink-0" />
      <span className="min-w-0">
        <span className="flex items-center gap-2 font-medium text-zinc-100">
          Atlassian Confluence
          {mutation.isPending ? (
            <Spinner className="size-4 text-zinc-400" aria-hidden />
          ) : null}
        </span>
        <span className="mt-1 block text-sm text-zinc-400">
          Sync spaces and pages from Confluence into ctxpipe and your linked Git
          repositories.
        </span>
      </span>
    </button>
  )
}
