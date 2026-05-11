"use client"

type OnboardingOverviewSlideProps = {
  onNext: () => void
}

export function OnboardingOverviewSlide({
  onNext,
}: OnboardingOverviewSlideProps) {
  return (
    <>
      <h2 className="onb-in-1 mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
        Your engineering context layer in one place
      </h2>
      <div className="onb-in-2 mb-6">
        <div className="mx-auto mb-6 max-w-3xl">
          <img
            src="/images/ctxpipe-onboarding-diagram.svg"
            alt="ctxpipe onboarding diagram"
            className="relative left-1/2 block h-auto w-[160%] max-w-none -translate-x-1/2"
            loading="eager"
          />
        </div>
        <p className="mx-auto mb-14 max-w-3xl text-balance text-zinc-300">
          All your engineering-focused institutional knowledge provided through
          a single intelligent, natural-language-based MCP. Connect Git, your
          engineering tools, then let your agents run to incrementally improve
          your knowledge system over time.
        </p>
      </div>
      <div className="onb-in-3">
        <button
          type="button"
          className="inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
          onClick={() => onNext()}
        >
          Next
        </button>
      </div>
    </>
  )
}
