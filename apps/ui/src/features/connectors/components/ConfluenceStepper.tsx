import { IconCheck } from "@tabler/icons-react"
import type { ConfluenceWizardStepDef } from "../confluence-setup-model"

type StepVisualState = "done" | "current" | "upcoming" | "done_after"

function statusForIndex(
  i: number,
  serverIndex: number,
  focusOverride: number | null | undefined,
  stepLength: number,
): StepVisualState {
  const len = stepLength
  if (focusOverride != null && focusOverride < serverIndex) {
    if (i < focusOverride) return "done"
    if (i === focusOverride) return "current"
    if (i < serverIndex) return "done_after"
    return "upcoming"
  }
  if (serverIndex >= len) {
    return i < serverIndex ? "done" : "upcoming"
  }
  if (i < serverIndex) return "done"
  if (i === serverIndex) return "current"
  return "upcoming"
}

type ConfluenceStepperProps = {
  steps: readonly ConfluenceWizardStepDef[]
  /** First incomplete step index, or `steps.length` when all done. */
  currentIndex: number
  /** When revisiting, this index is highlighted as active (must be `< currentIndex` when set). */
  focusOverride?: number | null
  /** Previous / current step clicks (wizard only). */
  onStepSelect?: (index: number) => void
  className?: string
}

export function ConfluenceStepper({
  steps,
  currentIndex,
  focusOverride = null,
  onStepSelect,
  className = "",
}: ConfluenceStepperProps) {
  return (
    <ol className={`space-y-2 ${className}`}>
      {steps.map((step, i) => {
        const state = statusForIndex(
          i,
          currentIndex,
          focusOverride,
          steps.length,
        )
        const isInteractive =
          onStepSelect &&
          (i < currentIndex || (focusOverride != null && i === currentIndex))

        const labelClasses =
          state === "upcoming"
            ? "text-muted-foreground"
            : state === "current"
              ? "font-medium text-foreground"
              : state === "done_after"
                ? "text-muted-foreground"
                : "text-muted-foreground"

        const icon =
          state === "done" || state === "done_after" ? (
            <span
              className={`flex size-5 shrink-0 items-center justify-center rounded-none border border-emerald-500 bg-zinc-900 ${state === "done_after" ? "opacity-60" : ""}`}
              aria-hidden
            >
              <IconCheck className="size-3.5 text-emerald-500" stroke={2.5} />
            </span>
          ) : (
            <span
              className={
                state === "current"
                  ? "flex size-5 shrink-0 items-center justify-center rounded-none border border-primary bg-zinc-900 text-xs font-medium text-primary"
                  : "flex size-5 shrink-0 items-center justify-center rounded-none border border-zinc-600 bg-zinc-900 text-xs text-muted-foreground"
              }
            >
              {i + 1}
            </span>
          )

        const label = (
          <div className={`min-w-0 pt-0.5 ${labelClasses}`}>{step.label}</div>
        )

        return (
          <li
            key={step.id}
            className="text-sm"
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
          >
            {isInteractive ? (
              <button
                type="button"
                className={`flex w-full min-w-0 gap-3 rounded-none text-left outline-none transition hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-primary/50 ${state === "done_after" ? "opacity-90" : ""}`}
                onClick={() => onStepSelect(i)}
              >
                <span className="mt-0.5 shrink-0">{icon}</span>
                {label}
              </button>
            ) : (
              <div className="flex gap-3">
                <span className="mt-0.5 shrink-0">{icon}</span>
                {label}
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}
