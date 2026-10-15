"use client"

import { useEffect, useState } from "react"
import { focusVisibleClassName } from "@/lib/focus-styles"

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
    // Reduced motion shows the full text at once: no timer, no typing.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setTypedCount(target.length)
      setShowDetails(true)
      onWelcomeDetailsVisible?.()
      return
    }
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
        className="mb-6 text-6xl text-zinc-100 sm:text-7xl"
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
        className={`mx-auto max-w-xl text-balance text-zinc-300 ${
          showDetails ? "opacity-100" : "opacity-0"
        }`}
      >
        Your team's knowledge, in a git repository you own. ctx| keeps it
        current and puts an agent to work in it.
      </p>
      <div
        className={`mt-8 ${
          showDetails ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        {/* A native button: the double-click guard (ignoreRepeatClick) needs click events. */}
        <button
          type="button"
          className={`${focusVisibleClassName} inline-flex h-11 items-center justify-center rounded-md border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200`}
          onClick={() => onGetStarted()}
        >
          Get started
        </button>
      </div>
    </>
  )
}
