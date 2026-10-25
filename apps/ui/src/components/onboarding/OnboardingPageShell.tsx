"use client"

import { AnimatedBackground } from "@/components/AnimatedBackground"

import { ignoreRepeatClick } from "./ignoreRepeatClick"

type OnboardingPageShellProps = {
  sceneReady: boolean
  sceneFailed: boolean
  onSceneLoad: () => void
  onSceneError: () => void
  children: React.ReactNode
}

export function OnboardingPageShell({
  sceneReady,
  sceneFailed,
  onSceneLoad,
  onSceneError,
  children,
}: OnboardingPageShellProps) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-zinc-950 text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_20%_-10%,rgba(255,255,255,0.05),transparent_45%),radial-gradient(circle_at_90%_110%,rgba(255,255,255,0.03),transparent_40%)]"
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 z-0 ${
          sceneReady && !sceneFailed ? "opacity-100" : "opacity-0"
        }`}
      >
        <AnimatedBackground
          filePath="/animations/onboarding/welcome-background.v1.json"
          fps={30}
          scale={0.9}
          dpi={1}
          lazyLoad
          startDelayMs={300}
          fixed
          production={false}
          className="h-full w-full"
          style={{ width: "100%", height: "100%" }}
          onLoad={onSceneLoad}
          onError={onSceneError}
        />
      </div>

      <a
        href="/.auth/sign-out"
        className="fixed left-4 top-4 z-20 text-xs text-zinc-500 transition-colors hover:text-teal-400 sm:left-6 sm:top-6"
      >
        Sign out
      </a>

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-6 pb-24 pt-16 text-center">
        <section className="w-full max-w-3xl">
          <div className="mx-auto max-w-3xl" onClickCapture={ignoreRepeatClick}>
            {children}
          </div>
        </section>
      </div>

      {sceneFailed ? (
        <p className="fixed inset-x-0 bottom-16 z-20 text-center text-xs text-zinc-500">
          Animation failed to load. Continue still works.
        </p>
      ) : null}
    </main>
  )
}
