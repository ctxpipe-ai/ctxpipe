"use client"

import { IconBrandNotion } from "@tabler/icons-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Spinner } from "@/components/ui/spinner"
import { createDraftNotionConnection } from "../queries/notion-connector"
import { orgConnectionsKeys } from "../queries/org-connections"

export type AddNotionConnectorButtonProps = {
  orgSlug: string
  /** Open the setup dialog. Its "Connect Notion" step starts OAuth. */
  onStart: (args: { connectionId: string }) => void
}

export function AddNotionConnectorButton({
  orgSlug,
  onStart,
}: AddNotionConnectorButtonProps) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => createDraftNotionConnection(orgSlug),
    onSuccess: async (draft) => {
      await queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
      onStart({ connectionId: draft.id })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <button
      type="button"
      disabled={mutation.isPending}
      className="group flex w-full items-start gap-4 rounded-md border border-border bg-card/40 p-4 text-left outline-none transition-colors hover:border-teal-400/40 hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-wait disabled:opacity-60"
      onClick={() => {
        void mutation.mutateAsync()
      }}
    >
      <span className="ctx-node size-12 transition-colors group-hover:border-teal-400/60 group-hover:bg-teal-400/5">
        <IconBrandNotion className="size-6 text-foreground" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 font-medium text-foreground">
          Notion
          {mutation.isPending ? (
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
