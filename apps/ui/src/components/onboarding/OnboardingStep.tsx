import { IconCheck, IconMinus } from "@tabler/icons-react"
import type { ReactNode } from "react"
import type { BeatState } from "./onboarding-state"

type OnboardingStepProps = {
  number: number
  title: string
  beat: BeatState
  /** Mono summary on the right once the step is done or skipped. */
  summary?: string
  /** e.g. "Connect now" on a skipped step. */
  action?: ReactNode
  children?: ReactNode
}

export function OnboardingStep({
  number,
  title,
  beat,
  summary,
  action,
  children,
}: OnboardingStepProps) {
  const open = beat === "current"
  return (
    <li className="border-b border-white/5 py-4">
      <div className="flex min-h-7 items-center gap-3">
        <span
          className={`inline-flex size-7 shrink-0 items-center justify-center border font-mono text-xs ${
            beat === "current"
              ? "border-teal-400 text-teal-400"
              : beat === "done"
                ? "border-white/10 bg-zinc-900 text-zinc-100"
                : beat === "skipped"
                  ? "border-dashed border-zinc-700 text-zinc-500"
                  : "border-white/10 text-zinc-500"
          }`}
        >
          {beat === "done" ? (
            <IconCheck className="size-3.5" aria-label="Done" />
          ) : beat === "skipped" ? (
            <IconMinus className="size-3.5" aria-label="Skipped" />
          ) : (
            number
          )}
        </span>
        <h2
          className={`m-0 text-base font-medium ${
            open
              ? "text-zinc-100"
              : beat === "done"
                ? "text-zinc-300"
                : "text-zinc-500"
          }`}
        >
          {title}
        </h2>
        <span className="ml-auto flex items-center gap-3">
          {summary ? (
            <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
              {summary}
            </span>
          ) : null}
          {action}
        </span>
      </div>
      {open && children ? (
        <div className="flex flex-col gap-4 pb-1 pl-10 pt-4">{children}</div>
      ) : null}
    </li>
  )
}
