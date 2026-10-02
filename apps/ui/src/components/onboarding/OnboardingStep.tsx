import { IconCheck, IconMinus } from "@tabler/icons-react"
import type { ReactNode } from "react"
import type { BeatState } from "./onboarding-state"

type OnboardingStepProps = {
  number: number
  title: string
  beat: BeatState
  /** Mono summary on the right once the step is done or skipped. */
  summary?: string
  /** Shows the body: the current step, or a done one reopened. */
  open: boolean
  /** Makes the title a button that opens or closes a done step. */
  onSelect?: () => void
  children?: ReactNode
}

export function OnboardingStep({
  number,
  title,
  beat,
  summary,
  open,
  onSelect,
  children,
}: OnboardingStepProps) {
  return (
    <li
      className={`flex flex-col border-b border-white/5 py-4 ${
        open ? "min-h-0 flex-1" : "shrink-0"
      }`}
    >
      <div className="flex min-h-7 items-center gap-3">
        <span
          className={`inline-flex size-7 shrink-0 items-center justify-center border font-mono text-xs ${
            // Only the open step looks active, even while an earlier one
            // is reopened.
            open && beat !== "done" && beat !== "skipped"
              ? "border-teal-400 text-teal-400"
              : beat === "current"
                ? "border-white/10 text-zinc-300"
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
          {onSelect ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={onSelect}
              className="cursor-pointer rounded-none text-left hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-400"
            >
              {title}
            </button>
          ) : (
            title
          )}
        </h2>
        <span className="ml-auto flex items-center gap-3">
          {summary ? (
            <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
              {summary}
            </span>
          ) : null}
        </span>
      </div>
      {open && children ? (
        // Fills the space left by the other steps and scrolls inside it; the
        // buttons sit at its bottom.
        <div className="onb-step-body flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-1 pl-10 pt-4">
          {children}
        </div>
      ) : null}
    </li>
  )
}

/** Every step's buttons: Back far left, the primary far right, its secondary beside it. */
export function StepActions({
  back,
  secondary,
  primary,
}: {
  back?: ReactNode
  secondary?: ReactNode
  primary?: ReactNode
}) {
  return (
    <div className="mt-auto flex flex-wrap items-center gap-3 pt-2">
      <div className="mr-auto">{back}</div>
      {secondary}
      {primary}
    </div>
  )
}
