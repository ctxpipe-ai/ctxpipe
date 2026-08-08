import { LinearMark } from "./LinearMark"

export type AddLinearConnectorButtonProps = {
  onStart: () => void
}

export function AddLinearConnectorButton({
  onStart,
}: AddLinearConnectorButtonProps) {
  return (
    <button
      type="button"
      className="group flex w-full items-start gap-4 rounded-none border border-border bg-card/40 p-4 text-left outline-none transition-colors hover:border-teal-400/40 hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-primary/50"
      onClick={onStart}
    >
      <span className="ctx-node size-12 transition-colors group-hover:border-teal-400/60 group-hover:bg-teal-400/5">
        <LinearMark className="size-6 text-foreground" />
      </span>
      <span className="min-w-0">
        <span className="font-medium text-foreground">Linear</span>
        <span className="mt-1 block text-sm text-muted-foreground">
          Sync projects, issues, documents, initiatives and customer requests
          into a linked Git repository.
        </span>
      </span>
    </button>
  )
}
