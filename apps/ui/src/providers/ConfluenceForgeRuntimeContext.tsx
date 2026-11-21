import { createContext, type ReactNode, useContext } from "react"

import type { ConfluenceForgeRuntimeConfig } from "@/lib/confluenceForgeRuntimeConfig"

const defaultConfig: ConfluenceForgeRuntimeConfig = {
  installUrlFallback: null,
}

const ConfluenceForgeRuntimeContext =
  createContext<ConfluenceForgeRuntimeConfig>(defaultConfig)

/**
 * Gives the Confluence (Forge) runtime config, for example the fallback install URL, to the app tree.
 * Providers mounts it at the root. Read the value with `useConfluenceForgeRuntime`.
 */
export function ConfluenceForgeRuntimeProvider({
  value,
  children,
}: {
  value: ConfluenceForgeRuntimeConfig
  children: ReactNode
}) {
  return (
    <ConfluenceForgeRuntimeContext.Provider value={value}>
      {children}
    </ConfluenceForgeRuntimeContext.Provider>
  )
}

export function useConfluenceForgeRuntime(): ConfluenceForgeRuntimeConfig {
  return useContext(ConfluenceForgeRuntimeContext)
}
