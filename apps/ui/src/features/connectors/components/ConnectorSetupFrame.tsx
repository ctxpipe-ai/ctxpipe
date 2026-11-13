import type { ReactNode } from "react"

import { Button } from "@/components/ui/Button"

/**
 * The frame of each connector setup dialog: a header, a body and a footer
 * on one grid. The header and the footer stay in view, and only the body
 * scrolls: the dialog (`Modal` with `flex flex-col`) is never taller than the
 * viewport, so the one Close control always shows. The mark of the header
 * and the body share one left edge; the step markers (`pl-2` on the steps)
 * share the center line of the mark.
 */
export function ConnectorSetupFrame(props: {
  icon: ReactNode
  title: string
  description: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-col">
      <header className="flex shrink-0 items-start gap-3 border-b border-white/[0.06] px-6 pt-6 pb-5">
        <span aria-hidden className="ctx-node h-9 w-9 shrink-0">
          {props.icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-medium tracking-tight text-foreground">
            {props.title}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {props.description}
          </p>
        </div>
      </header>
      <div className="flex min-h-0 flex-col gap-6 overflow-y-auto p-6">
        {props.children}
      </div>
      <footer className="flex shrink-0 justify-end border-t border-white/[0.06] px-6 py-4">
        <Button variant="secondary" onPress={props.onClose}>
          Close
        </Button>
      </footer>
    </div>
  )
}
