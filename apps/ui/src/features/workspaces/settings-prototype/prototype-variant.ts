/**
 * PROTOTYPE, throwaway. Lives only on the branch
 * `prototype/workspace-settings`. Do not merge into main.
 *
 * Question: what should Workspace settings look like, so that a user sees at
 * once what needs them and what runs, and finds each setting with one save
 * model? Four variants of the settings pane, on the real Workspace page,
 * switchable from a floating bar in Storybook ("Pages/Prototype/Workspace
 * settings"). "current" is today's pane.
 */
import { createContext, useContext, useEffect } from "react"

export const SETTINGS_VARIANTS = [
  { key: "current", name: "Current page" },
  { key: "A", name: "Overview and settings tabs" },
  { key: "B", name: "Health rail and edit rows" },
  { key: "C", name: "One card for each part" },
  { key: "D", name: "Wide cards, live status in sources" },
] as const

export type SettingsVariantKey = (typeof SETTINGS_VARIANTS)[number]["key"]

/** Null outside the prototype stories: the pane renders as on main. */
export const SettingsPrototypeContext =
  createContext<SettingsVariantKey | null>(null)

export function useSettingsPrototypeVariant(): SettingsVariantKey | null {
  return useContext(SettingsPrototypeContext)
}

/**
 * Variant D wants the full width: the pane opens maximized when it shows D.
 * The user can still restore the pane.
 */
export function useMaximizeForWideVariant(
  setMaximized: (value: boolean) => void,
) {
  const variant = useSettingsPrototypeVariant()
  useEffect(() => {
    if (variant === "D") setMaximized(true)
  }, [variant, setMaximized])
}
