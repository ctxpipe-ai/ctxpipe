import { IconCheck } from "@tabler/icons-react"
import type { ReactNode } from "react"

import {
  PullRequestsToMerge,
  usePullRequestMerges,
} from "@/features/workspace-sources/PullRequestsToMerge"
import type { OpenedPullRequest } from "@/features/workspace-sources/useAddToWorkspaces"

type StepVisualState = "done" | "current" | "upcoming" | "done_after"

type ConnectorSetupStepDef = {
  readonly id: string
  readonly label: string
}

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

type ConnectorSetupStepperProps = {
  steps: readonly ConnectorSetupStepDef[]
  /** First incomplete step index, or `steps.length` when all done. */
  currentIndex: number
  /** When revisiting, this index is highlighted as active (must be `< currentIndex` when set). */
  focusOverride?: number | null
  /** Previous / current step clicks (wizard only). */
  onStepSelect?: (index: number) => void
  /**
   * The merge step after the listed steps, when the save opened source pull
   * requests: a selected card with its number, its state and the links.
   */
  mergeStep?: {
    orgSlug: string
    pullRequests: OpenedPullRequest[]
    /** Replaces the default sentence, for a provider-specific note. */
    detail?: ReactNode
  }
  className?: string
}

/**
 * The marker of a setup step: a check when the step is done, else its
 * number. The marker of the current step has the primary border.
 */
function StepMarker({
  state,
  number,
}: {
  state: StepVisualState
  number: number
}) {
  if (state === "done" || state === "done_after") {
    return (
      <span
        className={`flex size-5 shrink-0 items-center justify-center rounded-md border border-emerald-500 bg-zinc-900 ${state === "done_after" ? "opacity-60" : ""}`}
        aria-hidden
      >
        <IconCheck className="size-3.5 text-emerald-500" stroke={2.5} />
      </span>
    )
  }
  return (
    <span
      className={
        state === "current"
          ? "flex size-5 shrink-0 items-center justify-center rounded-md border border-primary bg-zinc-900 text-xs font-medium text-primary"
          : "flex size-5 shrink-0 items-center justify-center rounded-md border border-zinc-600 bg-zinc-900 text-xs text-muted-foreground"
      }
    >
      {number}
    </span>
  )
}

export function ConnectorSetupStepper({
  steps,
  currentIndex,
  focusOverride = null,
  onStepSelect,
  mergeStep,
  className = "",
}: ConnectorSetupStepperProps) {
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

        const icon = <StepMarker state={state} number={i + 1} />

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
                className={`flex w-full min-w-0 gap-3 rounded-md text-left outline-none transition hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-primary/50 ${state === "done_after" ? "opacity-90" : ""}`}
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
      {mergeStep ? (
        <MergeStepItem number={steps.length + 1} {...mergeStep} />
      ) : null}
    </ol>
  )
}

/** The merge step: the stepper frames the content of `PullRequestsToMerge`. */
function MergeStepItem(props: {
  number: number
  orgSlug: string
  pullRequests: OpenedPullRequest[]
  detail?: ReactNode
}) {
  const merged = usePullRequestMerges(props.orgSlug, props.pullRequests)
  const done = merged.every(Boolean)
  return (
    <li
      className="-mx-3 mt-3 flex gap-3 rounded-md bg-muted/40 p-3 ring-1 ring-border ring-inset"
      data-state={done ? "done" : "current"}
      aria-current={done ? undefined : "step"}
    >
      <span className="mt-0.5 shrink-0">
        <StepMarker state={done ? "done" : "current"} number={props.number} />
      </span>
      <PullRequestsToMerge
        pullRequests={props.pullRequests}
        merged={merged}
        detail={props.detail}
      />
    </li>
  )
}
