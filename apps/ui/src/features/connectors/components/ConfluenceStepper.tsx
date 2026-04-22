import { IconCircleCheckFilled } from "@tabler/icons-react"
import { CONFLUENCE_CARD_STEP_DEFS } from "../confluence-setup-model"

type StepVisualState = "done" | "current" | "upcoming" | "done_after"

function statusForIndex(
  i: number,
  serverIndex: number,
  focusOverride: number | null | undefined,
): StepVisualState {
  const len = CONFLUENCE_CARD_STEP_DEFS.length
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
  /** First incomplete step index, or `CONFLUENCE_CARD_STEP_DEFS.length` when all done. */
  currentIndex: number
  /** When revisiting, this index is highlighted as active (must be `< currentIndex` when set). */
  focusOverride?: number | null
  /** Previous / current step clicks (wizard only). */
  onStepSelect?: (index: number) => void
  className?: string
}

export function ConfluenceStepper({
  currentIndex,
  focusOverride = null,
  onStepSelect,
  className = "",
}: ConfluenceStepperProps) {
  return (
    <ol className={`space-y-2 ${className}`}>
      {CONFLUENCE_CARD_STEP_DEFS.map((step, i) => {
        const state = statusForIndex(i, currentIndex, focusOverride)
        const isInteractive =
          onStepSelect &&
          (i < currentIndex || (focusOverride != null && i === currentIndex))

        const labelClasses =
          state === "upcoming"
            ? "text-zinc-500"
            : state === "current"
              ? "font-medium text-zinc-100"
              : state === "done_after"
                ? "text-zinc-400"
                : "text-zinc-300"

        const icon =
          state === "done" || state === "done_after" ? (
            <IconCircleCheckFilled
              className={`size-5 text-emerald-500 ${state === "done_after" ? "opacity-60" : ""}`}
              aria-hidden
            />
          ) : (
            <span
              className={
                state === "current"
                  ? "flex size-5 items-center justify-center rounded-full border-2 border-primary bg-zinc-900 text-xs font-medium text-primary"
                  : "flex size-5 items-center justify-center rounded-full border border-zinc-600 text-xs text-zinc-500"
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
                className={`flex w-full min-w-0 gap-3 rounded-md text-left outline-none transition hover:bg-zinc-900/60 focus-visible:ring-2 focus-visible:ring-primary/50 ${state === "done_after" ? "opacity-90" : ""}`}
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
