import { Button } from "react-aria-components"
import { PlainMark } from "./PlainMark"

type AddPlainConnectorButtonProps = {
  onStart: () => void
}

/** The catalog entry. Setup starts at the key step, with no draft row. */
export function AddPlainConnectorButton({
  onStart,
}: AddPlainConnectorButtonProps) {
  return (
    <Button
      className="group flex w-full items-start gap-4 rounded-md border border-border bg-card/40 p-4 text-left outline-none transition-colors hover:border-teal-400/40 hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-primary/50"
      onPress={onStart}
    >
      <span className="ctx-node size-12 transition-colors group-hover:border-teal-400/60 group-hover:bg-teal-400/5">
        <PlainMark className="size-6 text-foreground" />
      </span>
      <span className="min-w-0">
        <span className="block font-medium text-foreground">Plain</span>
        <span className="mt-1 block text-sm text-muted-foreground">
          Sync Help Center articles, and the support threads of selected labels.
        </span>
      </span>
    </Button>
  )
}
