/** Reads UI server env (Compose / k8s). Use from root route loader or server code — not build-time `VITE_*`. */
export type ConfluenceForgeRuntimeConfig = {
  /** When instance capabilities return no URL, use this before the baked-in default from `forge-install-url`. */
  installUrlFallback: string | null
}

export function getConfluenceForgeRuntimeConfig(): ConfluenceForgeRuntimeConfig {
  const v = process.env.CONFLUENCE_FORGE_INSTALL_URL?.trim()
  return { installUrlFallback: v || null }
}
