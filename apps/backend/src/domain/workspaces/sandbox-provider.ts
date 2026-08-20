import { assertNotInOrgDbContext } from "../../db/client.js"

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
  if (input.provider === "docker") {
    const docker = await import("@tanstack/ai-sandbox-docker").catch(() => null)
    await assertDockerDaemonReachable()
    await destroyWithProviderFactory({
      factory: docker?.dockerSandbox?.({ image: "node:22" }),
      provider: "docker",
      providerSandboxId: input.providerSandboxId,
    })
    return
  }
  if (input.provider === "sbx") {
    const docker = await import("@tanstack/ai-sandbox-docker").catch(() => null)
    await destroyWithProviderFactory({
      factory: docker?.sbxSandbox?.(),
      provider: "sbx",
      providerSandboxId: input.providerSandboxId,
    })
    return
  }
  if (
    input.provider === "local-process" ||
    input.provider === "local_process"
  ) {
    const local = await import("@tanstack/ai-sandbox-local-process").catch(
      () => null,
    )
    await destroyWithProviderFactory({
      factory: local?.localProcessSandbox?.(),
      provider: "local-process",
      providerSandboxId: input.providerSandboxId,
    })
    return
  }
  throw new Error(
    `Cannot destroy detached sandbox for provider ${input.provider ?? "unknown"}`,
  )
}

async function assertDockerDaemonReachable(): Promise<void> {
  const Dockerode = await import("dockerode").catch(() => null)
  const Docker = Dockerode?.default ?? Dockerode
  if (typeof Docker !== "function") {
    throw new Error("Cannot verify Docker daemon for detached destroy")
  }
  await new (Docker as new () => { ping: () => Promise<unknown> })().ping()
}

async function destroyWithProviderFactory(input: {
  factory?: {
    destroy: (args: { id: string }) => Promise<void>
    resume?: (args: { id: string }) => Promise<unknown>
  }
  provider: string
  providerSandboxId: string
}): Promise<void> {
  assertNotInOrgDbContext()
  if (!input.factory) {
    throw new Error(`Cannot destroy detached ${input.provider} sandbox`)
  }
  await input.factory.destroy({ id: input.providerSandboxId })
  const remaining = await input.factory.resume?.({
    id: input.providerSandboxId,
  })
  if (remaining) {
    throw new Error(
      `Provider sandbox ${input.providerSandboxId} still exists after destroy`,
    )
  }
}
