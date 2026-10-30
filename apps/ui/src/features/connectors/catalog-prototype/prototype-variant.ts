/**
 * PROTOTYPE, throwaway. Lives only on branch prototype/connector-catalog.
 * Do not merge into main.
 *
 * Question (CTX-1078): what should "Add connection" look like now that
 * ctxpipe has 10+ connectors and more come? Three variants of the connector
 * catalog, on the real Connectors page, switchable from a floating bar in
 * Storybook ("Pages/Prototype/Connector catalog"). "current" is today's
 * dialog.
 */
import { createContext, useContext } from "react"

import type { ConnectorHealth } from "../connectorHealth"

export const CATALOG_VARIANTS = [
  { key: "current", name: "Current dialog" },
  { key: "A", name: "Grouped tiles in the dialog" },
  { key: "B", name: "Two panes: groups and rows" },
  { key: "C", name: "Full page with sections" },
] as const

export type CatalogVariantKey = (typeof CATALOG_VARIANTS)[number]["key"]

/**
 * Facts that the connection list does not give: the deployment, and the
 * health of a connection (today each card reads it from its own status).
 */
export type CatalogFacts = {
  deployment: "hosted" | "self_host"
  /** By connection id. A connection that is not here is healthy. */
  health: Record<
    string,
    Extract<ConnectorHealth, "setup_pending" | "reconnect">
  >
}

/** Null outside the prototype stories: the page renders as on main. */
export const CatalogPrototypeContext = createContext<{
  variant: CatalogVariantKey
  facts: CatalogFacts
} | null>(null)

export function useCatalogPrototype() {
  return useContext(CatalogPrototypeContext)
}
