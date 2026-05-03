/** Reads UI server env (Compose / k8s). Use from root route loader or server code — not client `import.meta.env`. */
export type ConfluenceForgeRuntimeConfig = {
  /**
   * When capabilities fail to load, Install may use SSR `CONFLUENCE_FORGE_INSTALL_URL` before the
   * committed default (`forge-install-url.ts`).
   */
  installUrlFallback: string | null
}

export function getConfluenceForgeRuntimeConfig(): ConfluenceForgeRuntimeConfig {
  const v = process.env.CONFLUENCE_FORGE_INSTALL_URL?.trim()
  return { installUrlFallback: v || null }
}
