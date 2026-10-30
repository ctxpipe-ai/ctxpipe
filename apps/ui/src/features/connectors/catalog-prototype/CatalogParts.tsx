/**
 * PROTOTYPE, throwaway. Lives only on branch prototype/connector-catalog.
 * Do not merge into main.
 *
 * Question (CTX-1078): what should "Add connection" look like with 10+
 * connectors? The small parts that each variant may use: the status (dot
 * plus word, as on the connection rows) and the "Ask for it" link. Layout
 * stays in each variant.
 */
import { Button as RACButton } from "react-aria-components"

import { focusVisibleClassName } from "@/lib/focus-styles"

import type { CatalogEntry, CatalogId, EntryState } from "./catalog-data"
import { entryStatus } from "./catalog-data"
import { askForIt } from "./catalog-start"

/** What a variant gets: the entries with their state, and the actions. */
export type CatalogVariantProps = {
  entries: { entry: CatalogEntry; state: EntryState }[]
  pendingId: CatalogId | null
  onStart: (id: CatalogId) => void
  onClose: () => void
}

const TONE = {
  ok: { text: "text-emerald-400", dot: "bg-emerald-400" },
  warn: { text: "text-amber-400", dot: "bg-amber-400" },
  muted: { text: "text-muted-foreground", dot: "bg-zinc-500" },
} as const

export function CatalogStatus(props: { state: EntryState }) {
  const status = entryStatus(props.state)
  if (!status) return null
  const tone = TONE[status.tone]
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 font-mono text-xs ${tone.text}`}
    >
      <span aria-hidden className={`size-1.5 rounded-full ${tone.dot}`} />
      {status.label}
    </span>
  )
}

export function AskForIt(props: { name: string; label?: string }) {
  return (
    <RACButton
      className={`rounded-md text-xs text-teal-400 underline-offset-4 transition-colors hover:text-teal-300 hover:underline ${focusVisibleClassName}`}
      aria-label={`Ask for ${props.name}`}
      onPress={() => askForIt(props.name)}
    >
      {props.label ?? "Ask for it"}
    </RACButton>
  )
}

/** True when a press on the entry starts a setup. */
export function canStart(state: EntryState) {
  return state.kind === "available"
}
