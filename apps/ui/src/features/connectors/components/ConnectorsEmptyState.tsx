import { IconPlugConnected } from "@tabler/icons-react"
import { Button } from "@/components/ui/Button"

type ConnectorsEmptyStateProps = {
  onAddConnection: () => void
}

export function ConnectorsEmptyState({
  onAddConnection,
}: ConnectorsEmptyStateProps) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center text-center">
      <div className="ctx-node mx-auto mb-6 h-10 w-10">
        <IconPlugConnected
          className="h-4 w-4 text-muted-foreground"
          aria-hidden
        />
      </div>
      <h2 className="text-xl font-medium tracking-tight text-foreground">
        No connections yet
      </h2>
      <p className="mx-auto mt-3 max-w-md leading-relaxed text-muted-foreground">
        Connections pull docs, wikis, repos, and other sources into ctx| so your
        team loads real data into context—grounding agents and workflows instead
        of relying on whatever happens to be in the thread.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button
          variant="outline"
          className="rounded-none"
          onPress={onAddConnection}
        >
          Add connection
        </Button>
      </div>
    </div>
  )
}
