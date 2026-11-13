import { randomBytes } from "node:crypto"

import type {
  SandboxHandle,
  SandboxProvider as TanstackSandboxProvider,
} from "@tanstack/ai-sandbox"
import Docker from "dockerode"

import { assertNotInOrgDbContext } from "../../db/client.js"
import {
  countVercelSandboxRows,
  type RunningSandboxProvider,
} from "../../models/workspace-sandboxes.js"
import { flushEvlog, log } from "../../observability/logger.js"
import { writeProxyCa } from "./agent-vault.js"
import {
  agentCoreRuntime,
  agentCoreSandboxProvider,
} from "./agentcore-sandbox-provider.js"
import { wrapSandboxHandles } from "./sandbox-process-guards.js"

/**
 * Hosted runs AgentCore, self-host runs Docker; unsandboxed is explicit
 * only.
 */
export const SANDBOX_PROVIDERS = ["docker", "agentcore", "unsandboxed"] as const

export type SandboxProvider = (typeof SANDBOX_PROVIDERS)[number]

/**
 * The provider `SANDBOX_PROVIDER` locks, if any. A production process (the
 * backend and worker images set `NODE_ENV=production`: hosted, Compose and
 * CDK) refuses `unsandboxed`: the agent would run with the backend's
 * credentials. It stays for local development and tests.
 */
export function lockedSandboxProvider(
  env: Record<string, string | undefined> = process.env,
): SandboxProvider | undefined {
  const locked = env.SANDBOX_PROVIDER?.trim()
  if (!locked) return undefined
  if (!(SANDBOX_PROVIDERS as readonly string[]).includes(locked))
    throw new Error(`Unknown SANDBOX_PROVIDER "${locked}"`)
  if (locked === "unsandboxed" && env.NODE_ENV === "production")
    throw new Error(
      "SANDBOX_PROVIDER=unsandboxed is for local development only. Use docker or agentcore.",
    )
  return locked as SandboxProvider
}

let warnedUnsandboxed = false

/**
 * Logs once per process when chat is explicitly unsandboxed. Called at
 * startup and on each provider selection. Throws for a value that
 * {@link lockedSandboxProvider} refuses, so such a process does not start.
 */
export function warnIfUnsandboxed(
  env: Record<string, string | undefined> = process.env,
): void {
  if (warnedUnsandboxed || lockedSandboxProvider(env) !== "unsandboxed") return
  warnedUnsandboxed = true
  log.warn({
    step: "sandbox-provider",
    message:
      "SANDBOX_PROVIDER=unsandboxed: Workspace chat agents run as processes in this container with its network access and credentials",
  })
}

/**
 * Refuses the start of the backend or the worker while the database holds a
 * sandbox row of the removed Vercel provider (CTX-1220, ADR-048). This code
 * cannot delete the Vercel sandbox or snapshot of such a row. The retirement
 * script of the release before this one deletes them and the rows. The error
 * gives the count only, never an org or a sandbox id. Call it after
 * `initDb`, before the process serves a request or runs a job.
 */
export async function refuseVercelSandboxRows(
  orgIds?: readonly string[],
): Promise<void> {
  const rows = await countVercelSandboxRows(orgIds)
  if (rows === 0) return
  const message = `Sandbox rows of the removed Vercel provider are in the database (count: ${rows}). This release cannot delete their Vercel sandboxes and snapshots, so it does not start. With the release before this one, run \`bun src/scripts/retireVercelSandboxes.ts\` in apps/backend until it reports no rows. Then start this release again.`
  log.error({ step: "vercel-sandbox-rows", message, rows })
  await flushEvlog()
  throw new Error(message)
}

/**
 * The provider for a chat turn. Without a lock it is Docker, and only when
 * the daemon answers: an unreachable daemon fails the turn (503) and never
 * falls back to unsandboxed, which needs `SANDBOX_PROVIDER=unsandboxed`.
 */
export async function discoverSandboxProvider(
  env: Record<string, string | undefined> = process.env,
): Promise<SandboxProvider> {
  const provider = lockedSandboxProvider(env) ?? "docker"
  warnIfUnsandboxed(env)
  if (provider === "agentcore") {
    configuredAgentCoreProvider(env)
    return provider
  }
  if (provider !== "docker") return provider
  // docker-modem accepts a connection deadline beyond Dockerode's declarations.
  const docker = new Docker({ timeout: 2_000, connectionTimeout: 2_000 } as {
    timeout: number
  })
  try {
    await docker.ping()
  } catch (error) {
    const daemon = env.DOCKER_HOST?.trim() || "the local Docker socket"
    throw new Error(
      `Workspace chat sandboxes are unavailable: the Docker daemon at ${daemon} is not reachable`,
      { cause: error },
    )
  }
  return "docker"
}

/**
 * The OpenCode password for one turn's agent port. The OpenCode server must
 * hold it, so it is in the sandbox. A new one each turn makes it useless
 * after the turn: the next turn stops the earlier server and starts one with
 * its own password.
 */
export function turnAgentPassword(): string {
  return randomBytes(24).toString("hex")
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
  return wrapSandboxHandles(
    provider,
    (handle) => handle,
    (options) => ({ ...options, env: undefined }),
  )
}

/**
 * Docker sandboxes trust the run's Agent Vault CA. The file is written on
 * every create and attach, before the stock clone runs; the CA is public.
 */
export function withProxyCa(
  provider: TanstackSandboxProvider,
  caPem: string | undefined,
): TanstackSandboxProvider {
  if (!caPem) return provider
  return wrapSandboxHandles(provider, async (handle) => {
    await writeProxyCa(handle, caPem)
    return handle
  })
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
 * password and reachable from this process. Stock `ports.connect`
 * returns `localhost:<published port>`, which only works when the daemon runs
 * on this machine; for a remote daemon the port is published on its host.
 */
export function withDockerAgentPort(
  provider: TanstackSandboxProvider,
  input: { agentPassword: string; daemonHost?: string },
): TanstackSandboxProvider {
  const authorization = `Basic ${Buffer.from(`opencode:${input.agentPassword}`).toString("base64")}`
  return wrapSandboxHandles(provider, async (handle) => {
    // On the handle, not only in workspace secrets, so `opencode serve` never
    // starts without a password.
    await handle.env.set({ OPENCODE_SERVER_PASSWORD: input.agentPassword })
    return {
      ...handle,
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
  })
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

/**
 * The deployment's AgentCore sandboxes. Throws when the runtime is not set,
 * so an AgentCore deployment without it fails closed.
 */
export function configuredAgentCoreProvider(
  env: Record<string, string | undefined> = process.env,
) {
  const runtime = agentCoreRuntime(env)
  if (!runtime)
    throw new Error(
      "AgentCore sandboxes are unavailable: AGENTCORE_RUNTIME_ARN is not set",
    )
  // The image user is root; the agent runs as node, as in a Docker sandbox.
  return agentCoreSandboxProvider({ runtime, user: "node" })
}

export async function destroyDetachedProviderSandbox(input: {
  provider?: string | null
  providerSandboxId: string
  snapshotId?: string
}): Promise<void> {
  if (input.provider === "docker") {
    const docker = await import("@tanstack/ai-sandbox-docker").catch(() => null)
    await assertDockerDaemonReachable()
    await destroyWithProviderFactory({
      factory: docker?.dockerSandbox?.({ image: "node:24" }),
      provider: "docker",
      providerSandboxId: input.providerSandboxId,
      snapshotId: input.snapshotId,
    })
    return
  }
  if (input.provider === "agentcore") {
    await configuredAgentCoreProvider().destroy({ id: input.providerSandboxId })
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
 * A command handle on a conversation sandbox outside the chat run's setup,
 * started if it was stopped: the sweep's last push before it deletes the
 * sandbox. Null when the sandbox is gone. `onlyRunning` (a Files read while
 * a turn runs) never starts or resumes a sandbox: null when it does not run.
 */
export async function attachProviderSandbox(input: {
  provider: RunningSandboxProvider
  providerSandboxId: string
  onlyRunning?: boolean
  signal?: AbortSignal
}): Promise<SandboxHandle | null> {
  if (input.provider === "docker") {
    const docker = new Docker({ timeout: 30_000 })
    const container = docker.getContainer(input.providerSandboxId)
    const running = await container.inspect({ abortSignal: input.signal }).then(
      (info) => info.State.Running,
      () => null,
    )
    if (running === null) return null
    if (!running) {
      if (input.onlyRunning) return null
      await container.start()
    }
    const { DockerHandle } = await import("@tanstack/ai-sandbox-docker")
    return new DockerHandle({
      docker,
      container,
      // The stock provider's default, which chat sandboxes use.
      workdir: "/workspace",
      forkFactory: () => Promise.reject(new Error("Not forkable")),
      removeOnDestroy: false,
    })
  }
  // A session that ended gives null; a stopped one does not exist.
  return configuredAgentCoreProvider().resume({
    id: input.providerSandboxId,
    ...(input.signal ? { signal: input.signal } : {}),
  })
}

/**
 * Stop a Docker sandbox and keep its files (the stock provider's `resume`
 * starts it again). A sandbox that is already stopped or gone counts as
 * stopped; the next turn resumes or recreates it. Only Docker keeps the
 * files: the lifecycle deletes an AgentCore sandbox instead.
 */
export async function stopDetachedProviderSandbox(input: {
  providerSandboxId: string
}): Promise<void> {
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
