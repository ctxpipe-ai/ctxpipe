/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Better Auth / API origin when it differs from the UI (e.g. portless subdomains). */
  readonly VITE_PUBLIC_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
