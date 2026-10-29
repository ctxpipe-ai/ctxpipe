import { type ReactNode, type RefObject, useEffect, useRef } from "react"

import { scrollToPaneTop } from "@/lib/scroll-pane"
import { cn } from "@/lib/utils"

/** The parts of Workspace settings, each one a card. */
export type SettingsPart =
  | "upgrades"
  | "sources"
  | "graph"
  | "repository"
  | "general"
  | "danger"

/** The title of each card. The summary links to a card by its title. */
export const settingsPartTitle: Record<SettingsPart, string> = {
  upgrades: "Upgrades",
  sources: "Sources",
  graph: "Knowledge graph",
  repository: "Repository",
  general: "Workspace",
  danger: "Danger zone",
}

const settingsCardId = (part: SettingsPart) => `workspace-settings-${part}`

/** Moves the view and the focus to a card. */
export function jumpToSettingsCard(part: SettingsPart) {
  const card = document.getElementById(settingsCardId(part))
  if (!card) return
  scrollToPaneTop(card)
  // A plain focus also scrolls the outer boxes.
  card.focus({ preventScroll: true })
}

/**
 * A link can land on a card (#upgrades from a Home notice): the card gets the
 * focus and stays at the top while the cards above it load, until the user
 * scrolls, or for a few seconds.
 */
function useLanding(ref: RefObject<HTMLElement | null>, landing: boolean) {
  useEffect(() => {
    const card = ref.current
    if (!landing || !card) return
    const toStart = () => scrollToPaneTop(card)
    card.focus({ preventScroll: true })
    toStart()
    const keep = new ResizeObserver(toStart)
    if (card.parentElement) keep.observe(card.parentElement)
    const stop = () => keep.disconnect()
    const timer = setTimeout(stop, 3000)
    const events = ["wheel", "touchstart", "keydown"] as const
    for (const event of events) window.addEventListener(event, stop)
    return () => {
      stop()
      clearTimeout(timer)
      for (const event of events) window.removeEventListener(event, stop)
    }
  }, [ref, landing])
}

/**
 * One part of the Workspace: its state, its settings, and its actions. The
 * body states the state one time. The header shows only what the body does
 * not, for example "Up to date". An amber edge marks a card that needs the
 * user.
 */
export function SettingsCard(props: {
  part: SettingsPart
  description?: ReactNode
  /** A short muted word on the right of the title. */
  status?: ReactNode
  needsYou?: boolean
  danger?: boolean
  /** A link landed on this card. */
  landing?: boolean
  children: ReactNode
  footer?: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  useLanding(ref, props.landing ?? false)
  const id = settingsCardId(props.part)
  return (
    <section
      ref={ref}
      id={id}
      tabIndex={-1}
      aria-labelledby={`${id}-title`}
      className={cn(
        "scroll-mt-4 rounded-md border border-white/[0.07] bg-zinc-900/30 outline-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-teal-400/60",
        props.needsYou && "border-l-2 border-l-amber-400/70",
        props.danger && "border-red-400/15",
      )}
    >
      <div className="flex items-start justify-between gap-3 px-5 pt-4">
        <div className="min-w-0">
          <h2
            id={`${id}-title`}
            className="text-sm font-medium text-foreground"
          >
            {settingsPartTitle[props.part]}
          </h2>
          {props.description ? (
            <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
              {props.description}
            </p>
          ) : null}
        </div>
        {props.status ? (
          <p className="shrink-0 pt-0.5 text-xs text-muted-foreground">
            {props.status}
          </p>
        ) : null}
      </div>
      <div className="px-5 pt-3 pb-4">{props.children}</div>
      {props.footer ? (
        <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-3">
          {props.footer}
        </div>
      ) : null}
    </section>
  )
}
