import { IconCheck, IconCopy, IconEye, IconEyeOff } from "@tabler/icons-react"
import { useState } from "react"
import { Button } from "@/components/ui/Button"

type CopyState = "idle" | "copied" | "error"

type CopyableBlockProps = {
  value: string
  copiedAriaLabel: string
  copyAriaLabel: string
  copyErrorMessage?: string
  variant?: "default" | "secret"
  revealAriaLabel?: string
  hideAriaLabel?: string
}

export function CopyableBlock({
  value,
  copiedAriaLabel,
  copyAriaLabel,
  copyErrorMessage = "Could not copy — copy the URL manually.",
  variant = "default",
  revealAriaLabel = "Show value",
  hideAriaLabel = "Hide value",
}: CopyableBlockProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle")
  const [isSecretVisible, setIsSecretVisible] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopyState("copied")
      window.setTimeout(() => setCopyState("idle"), 2000)
    } catch {
      setCopyState("error")
      window.setTimeout(() => setCopyState("idle"), 2000)
    }
  }

  return (
    <>
      <div className="flex w-full min-w-0 items-stretch overflow-hidden rounded-md border border-border bg-muted/50">
        <div className="flex min-h-10 min-w-0 flex-1 items-stretch">
          <div
            className={
              variant === "secret" && isSecretVisible && value
                ? "min-w-0 flex-1 px-2 py-2 font-mono text-xs text-foreground"
                : variant === "secret"
                  ? "flex min-h-10 min-w-0 flex-1 items-center px-2 font-mono text-xs text-foreground"
                  : "flex min-h-10 min-w-0 flex-1 items-center overflow-x-auto px-2"
            }
          >
            {variant === "secret" ? (
              value ? (
                isSecretVisible ? (
                  <span className="inline-block break-all select-text">{value}</span>
                ) : (
                  <span
                    className="block min-w-0 truncate select-none tracking-wider"
                    aria-hidden="true"
                  >
                    {"•".repeat(value.length)}
                  </span>
                )
              ) : (
                <span className="text-muted-foreground">…</span>
              )
            ) : (
              <code className="whitespace-nowrap font-mono text-sm text-muted-foreground">
                {value}
              </code>
            )}
          </div>
          {variant === "secret" ? (
            <div className="flex shrink-0 items-stretch border-l border-border">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="h-full min-h-10 w-10 shrink-0 rounded-none text-muted-foreground hover:bg-foreground/6 hover:text-foreground"
                aria-label={isSecretVisible ? hideAriaLabel : revealAriaLabel}
                aria-pressed={isSecretVisible}
                isDisabled={!value}
                onPress={() => setIsSecretVisible((v) => !v)}
              >
                {isSecretVisible ? (
                  <IconEyeOff className="h-4 w-4" aria-hidden />
                ) : (
                  <IconEye className="h-4 w-4" aria-hidden />
                )}
              </Button>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-stretch border-l border-border">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={
              copyState === "copied"
                ? "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-emerald-600 transition-colors duration-200 hover:bg-emerald-500/10 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-400"
                : "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-primary transition-colors duration-200 hover:bg-primary/10 hover:text-primary pressed:bg-primary/15"
            }
            aria-label={copyState === "copied" ? copiedAriaLabel : copyAriaLabel}
            isDisabled={!value}
            onPress={() => void handleCopy()}
          >
            {copyState === "copied" ? (
              <IconCheck
                className="h-4 w-4 transition-opacity duration-200"
                aria-hidden
              />
            ) : (
              <IconCopy
                className="h-4 w-4 transition-opacity duration-200"
                aria-hidden
              />
            )}
          </Button>
        </div>
      </div>
      {copyState === "error" ? (
        <output aria-live="polite" className="block text-xs text-destructive">
          {copyErrorMessage}
        </output>
      ) : null}
    </>
  )
}
