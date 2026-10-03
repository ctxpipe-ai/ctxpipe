import type {
  SandboxHandle,
  SandboxProvider as TanstackSandboxProvider,
} from "@tanstack/ai-sandbox"
import Docker from "dockerode"
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

/**
 * The host of a TCP Docker daemon from `DOCKER_HOST` (as dockerode reads it),
 * or undefined for the local socket.
 */
export function remoteDockerHost(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env.DOCKER_HOST?.trim()
  if (!value || value.startsWith("unix://") || value.startsWith("npipe://"))
    return undefined
  return new URL(value.includes("//") ? value : `tcp://${value}`).hostname
}

/**
 * Docker conversation sandboxes, with the agent port behind the OpenCode
 * password (as on Vercel) and reachable from this process. Stock `ports.connect`
 * returns `localhost:<published port>`, which only works when the daemon runs
 * on this machine; for a remote daemon the port is published on its host.
 */
export function withDockerAgentPort(
  provider: TanstackSandboxProvider,
  input: { agentPassword: string; daemonHost?: string },
): TanstackSandboxProvider {
  const authorization = `Basic ${Buffer.from(`opencode:${input.agentPassword}`).toString("base64")}`
  const wrap = async (handle: SandboxHandle): Promise<SandboxHandle> => {
    // On the handle, not only in workspace secrets, so `opencode serve` never
    // starts without a password.
    await handle.env.set({ OPENCODE_SERVER_PASSWORD: input.agentPassword })
    const { snapshot, fork } = handle
    return {
      ...handle,
      // DockerHandle keeps these on its prototype; spread drops them.
      ...(snapshot
        ? { snapshot: (label?: string) => snapshot.call(handle, label) }
        : {}),
      ...(fork ? { fork: async () => wrap(await fork.call(handle)) } : {}),
      destroy: () => handle.destroy(),
      ports: {
        connect: async (port) => {
          const channel = await handle.ports.connect(port)
          return {
            ...channel,
            url: input.daemonHost
              ? channel.url.replace(
                  /^http:\/\/localhost(?=[:/]|$)/,
                  `http://${input.daemonHost}`,
                )
              : channel.url,
            headers: { ...channel.headers, Authorization: authorization },
          }
        },
      },
    }
  }
  const { restoreSnapshot } = provider
  return {
    name: provider.name,
    capabilities: () => provider.capabilities(),
    create: async (options) => wrap(await provider.create(options)),
    resume: async (options) => {
      const handle = await provider.resume(options)
      return handle ? wrap(handle) : handle
    },
    destroy: (options) => provider.destroy(options),
    ...(restoreSnapshot
      ? {
          restoreSnapshot: async (options) =>
            wrap(await restoreSnapshot.call(provider, options)),
        }
      : {}),
  }
}

/**
 * The image's content id, pulled through the daemon on first use. The
 * deployment names a published image; the daemon only needs registry access.
 */
export async function dockerImageId(
  image: string,
  docker = new Docker({ timeout: 30_000 }),
): Promise<string> {
  try {
    return (await docker.getImage(image).inspect()).Id
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error
  }
  const stream = await docker.pull(image)
  await new Promise<void>((resolve, reject) =>
    docker.modem.followProgress(stream, (error) =>
      error ? reject(error) : resolve(),
    ),
  )
  return (await docker.getImage(image).inspect()).Id
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
