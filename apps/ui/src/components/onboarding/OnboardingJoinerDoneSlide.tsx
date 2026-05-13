"use client"

type OnboardingJoinerDoneSlideProps = {
  completing: boolean
  onFinish: () => Promise<void>
}

export function OnboardingJoinerDoneSlide({
  completing,
  onFinish,
}: OnboardingJoinerDoneSlideProps) {
  return (
    <>
      <h2 className="onb-in-1 mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
        Welcome aboard
      </h2>
      <div className="onb-in-2 mx-auto mb-10 max-w-3xl">
        <p className="mx-auto mb-8 text-zinc-300">
          You&apos;re all set. Your organisation is ready and waiting.
        </p>
      </div>
      <div className="onb-in-3">
        <button
          type="button"
          disabled={completing}
          className="inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 disabled:opacity-50"
          onClick={() => void onFinish()}
        >
          {completing ? "Finishing..." : "Get started"}
        </button>
      </div>
    </>
  )
}
