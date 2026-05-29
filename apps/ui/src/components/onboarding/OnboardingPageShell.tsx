"use client"

import { AnimatedBackground } from "@/components/AnimatedBackground"

type OnboardingPageShellProps = {
  completing: boolean
  transitioning: boolean
  showDotNav: boolean
  sceneReady: boolean
  currentSlide: number
  slideCount: number
  sceneFailed: boolean
  onSceneLoad: () => void
  onSceneError: () => void
  onGoToSlide: (index: number) => void
  children: React.ReactNode
}

export function OnboardingPageShell({
  completing,
  transitioning,
  showDotNav,
  sceneReady,
  currentSlide,
  slideCount,
  sceneFailed,
  onSceneLoad,
  onSceneError,
  onGoToSlide,
  children,
}: OnboardingPageShellProps) {
  return (
    <main
      className={`relative min-h-screen overflow-hidden bg-zinc-950 text-foreground transition-opacity duration-500 ${completing ? "opacity-0" : "opacity-100"}`}
    >
      {sceneFailed ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_20%_-10%,rgba(255,255,255,0.05),transparent_45%),radial-gradient(circle_at_90%_110%,rgba(255,255,255,0.03),transparent_40%)]"
        />
      ) : null}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
        <AnimatedBackground
          filePath="/animations/onboarding/welcome-background.v1.json"
          fps={60}
          scale={1}
          dpi={1.5}
          lazyLoad={false}
          fixed
          production={false}
          className="h-full w-full"
          style={{ width: "100%", height: "100%" }}
          onLoad={onSceneLoad}
          onError={onSceneError}
        />
      </div>

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-6 pb-24 pt-16 text-center">
        <section className="w-full max-w-3xl">
          <div
            className={`mx-auto max-w-3xl transition-opacity duration-300 ${
              transitioning || (!sceneReady && !sceneFailed)
                ? "pointer-events-none opacity-0"
                : "opacity-100"
            }`}
          >
            {children}
          </div>
        </section>
      </div>

      <div
        className={`fixed inset-x-0 bottom-8 z-20 flex items-center justify-center gap-1.5 transition-opacity duration-700 ${
          showDotNav && (sceneReady || sceneFailed) ? "opacity-100" : "opacity-0"
        }`}
      >
        {Array.from({ length: slideCount }, (_, index) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed slide count; index is stable
            key={index}
            type="button"
            aria-label={`Go to slide ${index + 1}`}
            className={`h-1.5 w-1.5 rounded-full transition-all ${
              index === currentSlide
                ? "scale-110 bg-teal-400"
                : "bg-zinc-600 hover:bg-zinc-500"
            }`}
            onClick={() => onGoToSlide(index)}
          />
        ))}
      </div>

      {sceneFailed ? (
        <p className="fixed inset-x-0 bottom-16 z-20 text-center text-xs text-zinc-500">
          Animation failed to load. Continue still works.
        </p>
      ) : null}
    </main>
  )
}
