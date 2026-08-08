import { IconCheck } from "@tabler/icons-react"

export type ConnectorSetupStepDef = {
  readonly id: string
  readonly label: string
}

type StepVisualState = "done" | "current" | "upcoming" | "done_after"

function statusForIndex(
  index: number,
  serverIndex: number,
  focusOverride: number | null | undefined,
  stepLength: number,
): StepVisualState {
  if (focusOverride != null && focusOverride < serverIndex) {
    if (index < focusOverride) return "done"
    if (index === focusOverride) return "current"
    if (index < serverIndex) return "done_after"
    return "upcoming"
  }
  if (serverIndex >= stepLength) {
    return index < serverIndex ? "done" : "upcoming"
  }
  if (index < serverIndex) return "done"
  if (index === serverIndex) return "current"
  return "upcoming"
}

type ConnectorSetupStepperProps = {
  steps: readonly ConnectorSetupStepDef[]
  currentIndex: number
  focusOverride?: number | null
  onStepSelect?: (index: number) => void
  className?: string
}

export function ConnectorSetupStepper({
  steps,
  currentIndex,
  focusOverride = null,
  onStepSelect,
  className = "",
}: ConnectorSetupStepperProps) {
  return (
    <ol className={`space-y-2 ${className}`}>
      {steps.map((step, index) => {
        const state = statusForIndex(
          index,
          currentIndex,
          focusOverride,
          steps.length,
        )
        const isInteractive =
          onStepSelect &&
          (index < currentIndex ||
            (focusOverride != null && index === currentIndex))
        const labelClasses =
          state === "current"
            ? "font-medium text-foreground"
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
              {index + 1}
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
                onClick={() => onStepSelect(index)}
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
