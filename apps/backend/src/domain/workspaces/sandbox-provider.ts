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

export async function destroyDetachedProviderSandbox(input: {
  provider?: string | null
  providerSandboxId: string
}): Promise<void> {
  const [docker, local] = await Promise.all([
    import("@tanstack/ai-sandbox-docker").catch(() => null),
    import("@tanstack/ai-sandbox-local-process").catch(() => null),
  ])
  if (input.provider === "docker" || input.provider === "sbx") {
    const factory = docker?.dockerSandbox?.({ image: "node:22" })
    if (!factory) {
      throw new Error(`Cannot destroy detached ${input.provider} sandbox`)
    }
    await factory.destroy({ id: input.providerSandboxId })
    const remaining = await factory.resume?.({ id: input.providerSandboxId })
    if (remaining) {
      throw new Error(
        `Provider sandbox ${input.providerSandboxId} still exists after destroy`,
      )
    }
    return
  }
  const localFactory = local?.localProcessSandbox?.()
  if (!localFactory) {
    throw new Error("Cannot destroy detached local sandbox")
  }
  await localFactory.destroy({ id: input.providerSandboxId })
  const remaining = await localFactory.resume?.({
    id: input.providerSandboxId,
  })
  if (remaining) {
    throw new Error(
      `Provider sandbox ${input.providerSandboxId} still exists after destroy`,
    )
  }
}
