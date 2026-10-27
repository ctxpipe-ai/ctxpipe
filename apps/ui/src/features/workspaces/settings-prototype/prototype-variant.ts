/**
 * PROTOTYPE, throwaway. Lives only on the branch
 * `prototype/workspace-settings`. Do not merge into main.
 *
 * Question: what should Workspace settings look like, so that a user sees at
 * once what needs them and what runs, and finds each setting with one save
 * model? Three structurally different variants of the settings pane, on the
 * real Workspace page, switchable from a floating bar in Storybook
 * ("Pages/Prototype/Workspace settings"). "current" is today's pane.
 */
import { createContext, useContext } from "react"

export const SETTINGS_VARIANTS = [
  { key: "current", name: "Current page" },
  { key: "A", name: "Overview and settings tabs" },
  { key: "B", name: "Health rail and edit rows" },
  { key: "C", name: "One card for each part" },
] as const

export type SettingsVariantKey = (typeof SETTINGS_VARIANTS)[number]["key"]

/** Null outside the prototype stories: the pane renders as on main. */
export const SettingsPrototypeContext =
  createContext<SettingsVariantKey | null>(null)

export function useSettingsPrototypeVariant(): SettingsVariantKey | null {
  return useContext(SettingsPrototypeContext)
}
