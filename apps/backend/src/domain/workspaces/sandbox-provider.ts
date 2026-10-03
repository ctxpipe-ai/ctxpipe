import type { SandboxProvider as TanstackSandboxProvider } from "@tanstack/ai-sandbox"
import { assertNotInOrgDbContext } from "../../db/client.js"

/** Hosted runs Vercel, self-host runs Docker; unsandboxed is explicit only. */
export const SANDBOX_PROVIDERS = ["docker", "vercel", "unsandboxed"] as const

export type SandboxProvider = (typeof SANDBOX_PROVIDERS)[number]

export function detectSandboxProvider(input: {
  locked?: string | null
  hasDocker?: boolean
}): SandboxProvider {
  const locked = input.locked?.trim()
  if (locked) {
    if ((SANDBOX_PROVIDERS as readonly string[]).includes(locked)) {
      return locked as SandboxProvider
    }
    throw new Error(`Unknown SANDBOX_PROVIDER "${locked}"`)
  }
  if (input.hasDocker) return "docker"
  return "unsandboxed"
}

export function detectSandboxProviderFromEnv(input?: {
  hasDocker?: boolean
  env?: Record<string, string | undefined>
}): SandboxProvider {
  const env = input?.env ?? process.env
  return detectSandboxProvider({
    locked: env.SANDBOX_PROVIDER,
    hasDocker: input?.hasDocker,
  })
}

/**
 * Keep secrets out of provider create requests. Docker's create endpoint takes
 * its options as a query string, so environment values would appear in request
 * URLs. Stock `ensure` sets the same secrets on the sandbox session after
 * create, so the create call does not need them.
 */
export function withSessionOnlyEnv(
  provider: TanstackSandboxProvider,
): TanstackSandboxProvider {
  const { restoreSnapshot } = provider
  return {
    name: provider.name,
    capabilities: () => provider.capabilities(),
    create: (input) => provider.create({ ...input, env: undefined }),
    resume: (input) => provider.resume(input),
    destroy: (input) => provider.destroy(input),
    ...(restoreSnapshot
      ? {
          restoreSnapshot: (input) =>
            restoreSnapshot.call(provider, { ...input, env: undefined }),
        }
      : {}),
  }
}

/** Discover an eligible provider using the native Docker client/environment. */
export async function discoverSandboxProvider(): Promise<SandboxProvider> {
  if (process.env.SANDBOX_PROVIDER?.trim())
    return detectSandboxProviderFromEnv()
  // Vercel is never discovered: hosted deployments lock SANDBOX_PROVIDER.
  const { default: Docker } = await import("dockerode")
  // docker-modem accepts a connection deadline beyond Dockerode's declarations.
  const options = {
    timeout: 2_000,
    connectionTimeout: 2_000,
  }
  const hasDocker = await new Docker(options).ping().then(
    () => true,
    () => false,
  )
  return detectSandboxProviderFromEnv({ hasDocker })
}

export async function destroyDetachedProviderSandbox(input: {
  /** Required for Vercel, whose token record is org-scoped. */
  orgId?: string
  provider?: string | null
  providerSandboxId: string
  snapshotId?: string
}): Promise<void> {
  if (input.provider === "docker") {
    const docker = await import("@tanstack/ai-sandbox-docker").catch(() => null)
    await assertDockerDaemonReachable()
    await destroyWithProviderFactory({
      factory: docker?.dockerSandbox?.({ image: "node:22" }),
      provider: "docker",
      providerSandboxId: input.providerSandboxId,
      snapshotId: input.snapshotId,
    })
    return
  }
  if (input.provider === "vercel") {
    // Deleting also removes the saved state and revokes the GitHub token.
    if (!input.orgId) throw new Error("Deleting a Vercel sandbox needs its org")
    const { deleteVercelSandbox, vercelCredentials } = await import(
      "./vercel-sandbox-provider.js"
    )
    const { sandboxGitTokenStore } = await import(
      "../../models/sandbox-git-tokens.js"
    )
    const { parseEnv } = await import("../../config/env.js")
    await deleteVercelSandbox({
      credentials: await vercelCredentials(),
      name: input.providerSandboxId,
      tokens: sandboxGitTokenStore(input.orgId, parseEnv(process.env)),
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
      snapshotId: input.snapshotId,
    })
    return
  }
  throw new Error(
    `Cannot destroy detached sandbox for provider ${input.provider ?? "unknown"}`,
  )
}

/**
 * Stop a sandbox and keep its files: Docker stops the container (the stock
 * provider's `resume` starts it again); Vercel saves its state and revokes
 * its GitHub token. A sandbox that is already stopped or gone counts as
 * stopped; the next turn resumes or recreates it.
 */
export async function stopDetachedProviderSandbox(input: {
  orgId: string
  provider: SandboxProvider
  providerSandboxId: string
}): Promise<void> {
  if (input.provider === "docker") {
    const { default: Docker } = await import("dockerode")
    try {
      // PID 1 is the stock keep-alive command, which ignores SIGTERM.
      await new Docker({ timeout: 30_000 })
        .getContainer(input.providerSandboxId)
        .stop({ t: 1 })
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      // 304: already stopped. 404: gone.
      if (status !== 304 && status !== 404) throw error
    }
    return
  }
  if (input.provider === "vercel") {
    const { stopVercelSandbox, vercelCredentials } = await import(
      "./vercel-sandbox-provider.js"
    )
    const { sandboxGitTokenStore } = await import(
      "../../models/sandbox-git-tokens.js"
    )
    const { parseEnv } = await import("../../config/env.js")
    await stopVercelSandbox({
      credentials: await vercelCredentials(),
      name: input.providerSandboxId,
      tokens: sandboxGitTokenStore(input.orgId, parseEnv(process.env)),
    })
    return
  }
  throw new Error(`Provider ${input.provider} has no sandbox to stop`)
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
    deleteSnapshot?: (args: { snapshotId: string }) => Promise<void>
  }
  provider: string
  providerSandboxId: string
  snapshotId?: string
}): Promise<void> {
  assertNotInOrgDbContext()
  if (!input.factory) {
    throw new Error(`Cannot destroy detached ${input.provider} sandbox`)
  }
  await input.factory.destroy({ id: input.providerSandboxId })
  if (input.snapshotId) {
    if (!input.factory.deleteSnapshot)
      throw new Error(`Provider ${input.provider} cannot delete snapshots`)
    await input.factory.deleteSnapshot({ snapshotId: input.snapshotId })
  }
  const remaining = await input.factory.resume?.({
    id: input.providerSandboxId,
  })
  if (remaining) {
    throw new Error(
      `Provider sandbox ${input.providerSandboxId} still exists after destroy`,
    )
  }
}
