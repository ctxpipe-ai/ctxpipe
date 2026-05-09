"use client"

import { useEffect, useState } from "react"

type OnboardingWelcomeSlideProps = {
  onGetStarted: () => void
  /** Fired once the hero text + CTA are revealed (dot nav can fade in). */
  onWelcomeDetailsVisible?: () => void
}

export function OnboardingWelcomeSlide({
  onGetStarted,
  onWelcomeDetailsVisible,
}: OnboardingWelcomeSlideProps) {
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
        window.setTimeout(() => {
          setShowDetails(true)
          onWelcomeDetailsVisible?.()
        }, 220)
      }
    }, 220)
    return () => window.clearInterval(typeTimer)
  }, [onWelcomeDetailsVisible])

  return (
    <>
      <h1
        className="onb-in-1 mb-6 text-6xl text-zinc-100 sm:text-7xl"
        style={{ fontFamily: "var(--font-geist-pixel-square)" }}
      >
        {"ctx|"
          .slice(0, typedCount)
          .split("")
          .map((char, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: typing animation; order is fixed
              key={index}
              className={char === "|" ? "text-teal-400" : ""}
            >
              {char}
            </span>
          ))}
      </h1>
      <p
        className={`onb-in-2 mx-auto max-w-2xl text-balance text-zinc-300 transition-opacity duration-700 ${
          showDetails ? "opacity-100" : "opacity-0"
        }`}
      >
        ctx| is the self-learning context layer for autonomous AI agent fleets
        for engineering orgs, and their humans, too.
      </p>
      <div
        className={`onb-in-3 mt-8 transition-all duration-700 ${
          showDetails
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-2 opacity-0"
        }`}
      >
        <button
          type="button"
          className="inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
          onClick={() => onGetStarted()}
        >
          Get started
        </button>
      </div>
    </>
  )
}
