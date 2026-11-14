import { Button } from "@/components/ui/Button"

type ConnectorsEmptyStateProps = {
  onAddConnection: () => void
  /** True when the page says why no connection can start now. */
  isDisabled?: boolean
}

export function ConnectorsEmptyState({
  onAddConnection,
  isDisabled,
}: ConnectorsEmptyStateProps) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center text-center">
      <h2 className="text-lg font-medium text-foreground">
        No connections yet
      </h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Add a connection to bring docs, wikis and repositories into ctxpipe.
      </p>
      <Button
        variant="primary"
        className="mt-6"
        isDisabled={isDisabled}
        onPress={onAddConnection}
      >
        Add connection
      </Button>
    </div>
  )
}
