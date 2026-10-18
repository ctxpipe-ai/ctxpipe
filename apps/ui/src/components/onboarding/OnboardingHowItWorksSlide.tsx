"use client"

import { IconFolderCode, IconRefresh, IconRobot } from "@tabler/icons-react"
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

const steps = [
  {
    icon: IconFolderCode,
    title: "Your team's knowledge, in git",
    body: "One repository of Markdown files. ctx| can create it for you.",
    delay: "delay-30",
  },
  {
    icon: IconRefresh,
    title: "Kept current",
    body: "Connectors copy Linear, Slack, Notion and merged pull requests into it. Each change is a commit that you can review.",
    delay: "delay-60",
  },
  {
    icon: IconRobot,
    title: "Ready for your agents",
    body: "Ask questions, edit files and open pull requests here or from the agent in your editor.",
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
          Welcome to ctx|
        </h1>
        <p className="mt-3 text-lg text-zinc-400">Here's how it works.</p>
      </div>
      <ul className="mx-auto mt-10 max-w-xl space-y-5 text-left">
        {steps.map((step) => (
          <li
            key={step.title}
            className={cn(
              "flex items-start gap-4",
              rowFadeClassName,
              step.delay,
            )}
          >
            <span className="ctx-node size-10 bg-zinc-950/70 text-teal-400 [&>svg]:size-5">
              <step.icon stroke={1.5} aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-base font-medium text-zinc-100">
                {step.title}
              </p>
              <p className="mt-1 text-pretty text-sm text-zinc-400">
                {step.body}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <div className={cn(rowFadeClassName, "delay-120")}>
        <p className="mx-auto mt-8 text-xs text-zinc-500">
          Turn ctx| off, and your knowledge stays in your repository.
        </p>
        <div className="mt-8">
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
      </div>
    </>
  )
}
