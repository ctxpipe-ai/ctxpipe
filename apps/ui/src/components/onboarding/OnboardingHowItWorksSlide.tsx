"use client"

import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"

type OnboardingHowItWorksSlideProps = {
  /** "Next" for a new organization; "Get started" finishes a joiner. */
  actionLabel: string
  isPending?: boolean
  onNext: () => void
}

/**
 * Each row fades in after the row above it (DESIGN.md "Motion", the
 * exception for the hand-off from onboarding: 100 ms, delays of 150 ms at
 * most). `fill-mode-backwards` keeps a row hidden during its delay. Reduced
 * motion shortens each animation to nothing (the global rule in `styles.css`).
 */
const rowFadeClassName =
  "animate-in fade-in slide-in-from-bottom-1 fill-mode-backwards duration-100 ease-out"

/** The three steps of the user: connect the sources, curate the knowledge, serve it to agents. */
const steps = [
  {
    number: "01",
    label: "Connect",
    body: "Link your code and tools. ctxpipe keeps them current as Markdown in your git.",
    delay: "delay-30",
  },
  {
    number: "02",
    label: "Curate",
    body: "Review every change, and edit the files like any git repository.",
    delay: "delay-60",
  },
  {
    number: "03",
    label: "Serve",
    body: "Point every agent at the same facts over MCP.",
    delay: "delay-90",
  },
]

export function OnboardingHowItWorksSlide({
  actionLabel,
  isPending,
  onNext,
}: OnboardingHowItWorksSlideProps) {
  return (
    <>
      <div className={rowFadeClassName}>
        <h1 className="text-3xl font-semibold text-zinc-100 sm:text-4xl">
          Welcome to ctxpipe
        </h1>
        <p className="mt-3 text-lg text-zinc-400">
          Context management for your software factory.
        </p>
      </div>
      <ol className="mt-10 grid divide-y divide-border rounded-md border border-border bg-zinc-950/90 text-left sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {steps.map((step) => (
          <li
            key={step.number}
            className={cn("flex flex-col p-5", rowFadeClassName, step.delay)}
          >
            <p className="ctx-label">
              <span className="text-teal-400">{step.number}</span> ·{" "}
              {step.label}
            </p>
            <p className="mt-3 text-pretty text-base text-zinc-200">
              {step.body}
            </p>
          </li>
        ))}
      </ol>
      <div className={cn(rowFadeClassName, "mt-10 delay-120")}>
        {/* A native button: the double-click guard (ignoreRepeatClick) needs click events. */}
        <button
          type="button"
          disabled={isPending}
          className={`${focusVisibleClassName} inline-flex h-11 items-center justify-center rounded-md border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 disabled:opacity-50`}
          onClick={() => onNext()}
        >
          {actionLabel}
        </button>
      </div>
    </>
  )
}
