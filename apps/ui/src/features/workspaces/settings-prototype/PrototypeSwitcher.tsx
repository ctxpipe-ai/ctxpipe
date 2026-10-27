/**
 * PROTOTYPE, throwaway (see prototype-variant.ts). The floating bar that
 * cycles the variants. It shows the scenario too, so the reader always knows
 * which state they look at. Only the prototype stories mount it.
 */
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react"
import { useEffect } from "react"

import { SETTINGS_VARIANTS, type SettingsVariantKey } from "./prototype-variant"

export function PrototypeSwitcher(props: {
  current: SettingsVariantKey
  onChange: (key: SettingsVariantKey) => void
  scenario: { name: string; about: string }
}) {
  const index = Math.max(
    0,
    SETTINGS_VARIANTS.findIndex((variant) => variant.key === props.current),
  )
  const step = (by: number) => {
    const next =
      SETTINGS_VARIANTS[
        (index + by + SETTINGS_VARIANTS.length) % SETTINGS_VARIANTS.length
      ]
    if (next) props.onChange(next.key)
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target?.closest("input, textarea, [contenteditable='true']") ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      )
        return
      if (!event.altKey) return
      event.preventDefault()
      step(event.key === "ArrowRight" ? 1 : -1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })
  const variant = SETTINGS_VARIANTS[index]
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex justify-center">
      <div className="pointer-events-auto flex max-w-[44rem] items-center gap-3 rounded-full border border-fuchsia-300/40 bg-fuchsia-950/95 px-2 py-1.5 text-fuchsia-50 shadow-2xl shadow-black/60">
        <button
          type="button"
          aria-label="Previous variant"
          className="flex size-7 items-center justify-center rounded-full hover:bg-fuchsia-800"
          onClick={() => step(-1)}
        >
          <IconChevronLeft className="size-4" aria-hidden />
        </button>
        <div className="min-w-0 text-center">
          <p className="truncate text-sm font-medium">
            Prototype {variant?.key === "current" ? "" : variant?.key}
            {variant?.key === "current" ? "" : " — "}
            {variant?.name}
          </p>
          <p
            className="truncate text-xs text-fuchsia-200/80"
            title={props.scenario.about}
          >
            Scenario: {props.scenario.name} · Alt + ← → to switch
          </p>
        </div>
        <button
          type="button"
          aria-label="Next variant"
          className="flex size-7 items-center justify-center rounded-full hover:bg-fuchsia-800"
          onClick={() => step(1)}
        >
          <IconChevronRight className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  )
}
