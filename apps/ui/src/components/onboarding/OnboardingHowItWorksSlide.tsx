"use client"

import { IconFolderCode, IconMessage, IconRefresh } from "@tabler/icons-react"
import { focusVisibleClassName } from "@/lib/focus-styles"

type OnboardingHowItWorksSlideProps = {
  /** "Next" for a new organization; "Get started" finishes a joiner. */
  actionLabel: string
  isPending?: boolean
  onNext: () => void
}

export function OnboardingHowItWorksSlide({
  actionLabel,
  isPending,
  onNext,
}: OnboardingHowItWorksSlideProps) {
  return (
    <>
      <h2 className="mb-8 text-3xl font-semibold text-zinc-100 sm:text-4xl">
        How ctx| works
      </h2>
      <ul className="mx-auto max-w-xl space-y-5 text-left">
        <li className="flex items-start gap-4">
          <span className="ctx-node size-10 bg-zinc-950/70 text-teal-400 [&>svg]:size-5">
            <IconFolderCode stroke={1.5} aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-base font-medium text-zinc-100">A Workspace</p>
            <p className="mt-1 text-pretty text-sm text-zinc-400">
              One git repository for your team's knowledge. ctx| can create it
              for you.
            </p>
          </div>
        </li>
        <li className="flex items-start gap-4">
          <span className="ctx-node size-10 bg-zinc-950/70 text-teal-400 [&>svg]:size-5">
            <IconRefresh stroke={1.5} aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-base font-medium text-zinc-100">Kept current</p>
            <p className="mt-1 text-pretty text-sm text-zinc-400">
              Connectors copy Linear, Slack, Notion and merged pull requests
              into it as Markdown. Each change is a commit you can review.
            </p>
          </div>
        </li>
        <li className="flex items-start gap-4">
          <span className="ctx-node size-10 bg-zinc-950/70 text-teal-400 [&>svg]:size-5">
            <IconMessage stroke={1.5} aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-base font-medium text-zinc-100">
              An agent that works in it
            </p>
            <p className="mt-1 text-pretty text-sm text-zinc-400">
              Ask questions, edit files and open pull requests. Your editor's
              agents can use it too.
            </p>
          </div>
        </li>
      </ul>
      <p className="mx-auto mt-8 text-xs text-zinc-500">
        Turn ctx| off and your knowledge stays in your repository.
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
    </>
  )
}
