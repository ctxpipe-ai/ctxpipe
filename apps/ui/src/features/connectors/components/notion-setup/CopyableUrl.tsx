"use client"

import { IconCheck, IconCopy } from "@tabler/icons-react"
import { useState } from "react"
import { Button } from "@/components/ui/Button"

export function CopyableUrl({
  url,
  label,
}: {
  url?: string
  label: string
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  )
  const display = url ?? "…"

  const onCopy = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopyState("copied")
      window.setTimeout(() => setCopyState("idle"), 2000)
    } catch {
      setCopyState("error")
      window.setTimeout(() => setCopyState("idle"), 2000)
    }
  }

  return (
    <div className="mt-2">
      <div className="flex w-full min-w-0 items-stretch overflow-hidden rounded-none border border-border bg-muted/50">
        <div className="flex min-h-10 min-w-0 flex-1 items-center overflow-x-auto px-2">
          <code className="break-all font-mono text-sm text-muted-foreground">
            {display}
          </code>
        </div>
        <div className="flex shrink-0 items-stretch border-l border-border">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={
              copyState === "copied"
                ? "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-600 dark:text-emerald-400"
                : "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-primary hover:bg-primary/10"
            }
            aria-label={
              copyState === "copied" ? `${label} copied` : `Copy ${label}`
            }
            isDisabled={!url}
            onPress={() => void onCopy()}
          >
            {copyState === "copied" ? (
              <IconCheck className="h-4 w-4" aria-hidden />
            ) : (
              <IconCopy className="h-4 w-4" aria-hidden />
            )}
          </Button>
        </div>
      </div>
      {copyState === "error" ? (
        <output
          aria-live="polite"
          className="mt-1 block text-xs text-destructive"
        >
          Could not copy — copy it manually.
        </output>
      ) : null}
    </div>
  )
}
