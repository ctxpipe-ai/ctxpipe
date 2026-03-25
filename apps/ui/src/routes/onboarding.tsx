import { createFileRoute, Navigate, useRouter } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { AnimatedBackground } from "@/components/AnimatedBackground"
import { hasCompletedOnboarding, markOnboardingCompleted } from "@/lib/onboarding"
import { useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/onboarding")({
  component: OnboardingPage,
})

function OnboardingPage() {
  const router = useRouter()
  const { data: session, isPending } = useSession()
  const [sceneFailed, setSceneFailed] = useState(false)
  const [typedCount, setTypedCount] = useState(0)
  const [showDetails, setShowDetails] = useState(false)

  useEffect(() => {
    const target = "ctx|"
    let index = 0
    const typeTimer = window.setInterval(() => {
      index += 1
      setTypedCount(index)
      if (index >= target.length) {
        window.clearInterval(typeTimer)
        window.setTimeout(() => setShowDetails(true), 220)
      }
    }, 220)

    return () => {
      window.clearInterval(typeTimer)
    }
  }, [])

  if (isPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />
  if (hasCompletedOnboarding(session.user.id)) return <Navigate to="/" replace />

  return (
    <main className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_20%_-10%,rgba(64,224,208,0.14),transparent_45%),radial-gradient(circle_at_90%_110%,rgba(59,130,246,0.12),transparent_40%)]"
      />
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
          onLoad={() => setSceneFailed(false)}
          onError={() => setSceneFailed(true)}
        />
      </div>

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-6 py-16 text-center">
        <section className="w-full max-w-3xl">
          <h1
            className="mb-6 text-6xl text-zinc-100 sm:text-7xl"
            style={{ fontFamily: "var(--font-geist-pixel-square)" }}
          >
            {["c", "t", "x", "|"].map((char, index) =>
              index < typedCount ? (
                <span key={char} className={char === "|" ? "text-teal-400" : ""}>
                  {char}
                </span>
              ) : null,
            )}
            {typedCount < 4 ? (
              <span className="ml-1 inline-block h-[0.9em] w-[0.08em] animate-pulse bg-teal-400 align-[-0.08em]" />
            ) : null}
          </h1>

          <p
            className={`mx-auto max-w-2xl text-balance text-zinc-300 transition-opacity duration-700 ${
              showDetails ? "opacity-100" : "opacity-0"
            }`}
          >
            ctx| is the self-learning context layer for engineering AI agents & humans.
          </p>

          <button
            type="button"
            className={`mt-8 inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-all duration-700 hover:bg-zinc-200 ${
              showDetails
                ? "translate-y-0 opacity-100"
                : "pointer-events-none translate-y-2 opacity-0"
            }`}
            onClick={() => {
              markOnboardingCompleted(session.user.id)
              void router.navigate({ to: "/", replace: true })
            }}
          >
            Get started
          </button>

          {sceneFailed ? (
            <p className="mt-4 text-xs text-zinc-500">
              Animation failed to load. Continue still works.
            </p>
          ) : null}
        </section>
      </div>
    </main>
  )
}
