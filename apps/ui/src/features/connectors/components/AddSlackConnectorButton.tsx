"use client"

import { IconBrandSlack } from "@tabler/icons-react"

export type AddSlackConnectorButtonProps = {
  orgSlug: string
  /** Open the setup dialog from the parent page so it outlives the catalog modal. */
  onOpenSetup: () => void
}

export function AddSlackConnectorButton({
  onOpenSetup,
}: AddSlackConnectorButtonProps) {
  return (
    <button
      type="button"
      className="group flex w-full items-start gap-4 rounded-none border border-border bg-card/40 p-4 text-left outline-none transition-colors hover:border-teal-400/40 hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-primary/50"
      onClick={onOpenSetup}
    >
      <span className="ctx-node size-12 transition-colors group-hover:border-teal-400/60 group-hover:bg-teal-400/5">
        <IconBrandSlack className="size-5 text-foreground" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="font-medium text-foreground">Slack</span>
        <span className="mt-1 block text-sm text-muted-foreground">
          Capture specific Slack threads into your context repository by
          mentioning the bot.
        </span>
      </span>
    </button>
  )
}
