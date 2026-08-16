export const SANDBOX_PROVIDERS = ["docker", "railway", "unsandboxed"] as const

export type SandboxProvider = (typeof SANDBOX_PROVIDERS)[number]

export function detectSandboxProvider(input: {
  locked?: string | null
  hasSbx?: boolean
  hasDocker?: boolean
}): SandboxProvider {
  const locked = input.locked?.trim()
  if (locked) {
    if ((SANDBOX_PROVIDERS as readonly string[]).includes(locked)) {
      return locked as SandboxProvider
    }
    throw new Error(`Unknown SANDBOX_PROVIDER "${locked}"`)
  }
  if (input.hasSbx) return "docker"
  if (input.hasDocker) return "docker"
  return "unsandboxed"
}

export function detectSandboxProviderFromEnv(input?: {
  hasSbx?: boolean
  hasDocker?: boolean
  env?: Record<string, string | undefined>
}): SandboxProvider {
  const env = input?.env ?? process.env
  return detectSandboxProvider({
    locked: env.SANDBOX_PROVIDER,
    hasSbx: input?.hasSbx,
    hasDocker: input?.hasDocker,
  })
}

export function sandboxMustFailClosed(input: {
  provider: SandboxProvider
  canEnforceLimits: boolean
}): boolean {
  if (input.provider === "unsandboxed") return false
  return !input.canEnforceLimits
}
