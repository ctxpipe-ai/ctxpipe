import { IconPlugConnected } from "@tabler/icons-react"
import { Button } from "@/components/ui/Button"

type ConnectorsEmptyStateProps = {
  onAddConnection: () => void
}

export function ConnectorsEmptyState({
  onAddConnection,
}: ConnectorsEmptyStateProps) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-900/30 px-6 py-12 text-center">
      <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-zinc-800 text-zinc-400">
        <IconPlugConnected className="size-8" aria-hidden />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-zinc-100">
        No connections yet
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-zinc-400">
        Connections pull docs, wikis, repos, and other sources into ctx| so your
        team loads real data into context—grounding agents and workflows instead
        of relying on whatever happens to be in the thread.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button variant="primary" onPress={onAddConnection}>
          Add connection
        </Button>
      </div>
    </div>
  )
}
