import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Spinner } from "@/components/ui/spinner"
import { orgConnectionsKeys } from "../queries/org-connections"
import { createPagerdutyDraft } from "../queries/pagerduty-connector"
import { PagerdutyMark } from "./PagerdutyMark"

export type AddPagerdutyConnectorButtonProps = {
  orgSlug: string
  onDraftCreated: (args: { connectionId: string }) => void
}

export function AddPagerdutyConnectorButton({
  orgSlug,
  onDraftCreated,
}: AddPagerdutyConnectorButtonProps) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => createPagerdutyDraft(orgSlug),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
      onDraftCreated({ connectionId: data.connectionId })
    },
    onError: (error: Error) => toast.error(error.message),
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
        <PagerdutyMark className="size-6 text-foreground" />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 font-medium text-foreground">
          PagerDuty
          {mutation.isPending ? (
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
