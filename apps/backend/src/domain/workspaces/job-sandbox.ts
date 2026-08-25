import {
  claimSandboxInstance,
  deleteSandboxInstance,
  persistSandboxInstance,
} from "../../models/workspaces.js"
import { scrubOriginAfterCloneCommand } from "./clone-credentials.js"
import type { JobSandboxHandle, JobWorktreeExec } from "./job-worktree.js"
import {
  destroyDetachedProviderSandbox,
  detectSandboxProviderFromEnv,
  type SandboxProvider,
} from "./sandbox-provider.js"
import { getJobSandbox, registerWorkspaceSandbox } from "./sandbox-registry.js"
import { workspaceWriteSandboxId } from "./write-runner.js"

export type TanstackLikeHandle = {
  id?: string
  process: {
    exec: JobWorktreeExec
  }
  fs: JobSandboxHandle["fs"]
  git?: {
    clone: (input: {
      url: string
      ref?: string
      auth?: { token: string }
      depth?: number | "full"
    }) => Promise<void>
  }
  destroy: () => Promise<void>
}

export class SandboxProviderUnavailableError extends Error {
  readonly provider: string
  constructor(provider: string) {
    super(`Sandbox provider ${provider} is locked or unavailable`)
    this.name = "SandboxProviderUnavailableError"
    this.provider = provider
  }
}

export function jobSandboxIsolation(
  provider: SandboxProvider,
): "docker" | null {
  return provider === "docker" ? "docker" : null
}

/** Product jobs use Docker only. Local-process is not a product adapter. */
export function resolveJobSandboxIsolation(input: {
  provider: SandboxProvider
  hasDocker: boolean
  hasLocal?: boolean
}): "docker" | null {
  void input.hasLocal
  if (input.provider === "docker" && input.hasDocker) return "docker"
  return null
}

export function jobProviderMatchesEffective(
  storedProvider: string | null | undefined,
  effective: "docker" | "sbx" | "local-process",
): boolean {
  if (!storedProvider) return false
  return jobProviderName(storedProvider) === effective
}

export function adaptTanstackHandle(
  handle: TanstackLikeHandle,
): JobSandboxHandle {
  return {
    exec: (command, options) => handle.process.exec(command, options),
    fs: handle.fs,
  }
}

export type JobSandboxCreateHooks = {
  persistLive: (input: {
    providerSandboxId: string
    provider: string
  }) => Promise<void>
  abandon: (input: {
    providerSandboxId: string
    provider: string
    destroyed: boolean
  }) => Promise<void>
  storedProvider?: string | null
}

export async function ensureJobSandbox(input: {
  orgId: string
  workspaceId: string
  desiredUrl: string
  desiredSha: string | null
  existing?: JobSandboxHandle | null
  create: (
    sandboxId: string,
    hooks: JobSandboxCreateHooks,
  ) => Promise<{
    handle: JobSandboxHandle
    destroy?: () => Promise<void>
    providerSandboxId?: string
    provider?: string
  } | null>
}): Promise<JobSandboxHandle | null> {
  if (input.existing) return input.existing
  const attached = getJobSandbox(input.workspaceId)
  if (attached) return attached
  const preferredId =
    workspaceWriteSandboxId({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      desiredUrl: input.desiredUrl,
      desiredSha: input.desiredSha,
    }) ?? `${input.orgId}:${input.workspaceId}:write`
  const claimed = await claimSandboxInstance({
    id: preferredId,
    kind: "job",
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    desiredUrl: input.desiredUrl,
    desiredSha: input.desiredSha,
    state: "live",
    lastHeartbeatAt: new Date(),
  })
  const attachedAfterClaim = getJobSandbox(input.workspaceId)
  if (attachedAfterClaim) return attachedAfterClaim
  if (!claimed.inserted && !claimed.record.providerSandboxId) {
    return getJobSandbox(input.workspaceId)
  }
  const resumeId = claimed.record.providerSandboxId ?? claimed.record.id
  const created = await input.create(resumeId, {
    storedProvider: claimed.record.providerSandboxId
      ? claimed.record.provider
      : undefined,
    persistLive: async ({ providerSandboxId, provider }) => {
      await persistSandboxInstance({
        ...claimed.record,
        provider,
        providerSandboxId,
        state: "live",
        lastHeartbeatAt: new Date(),
      })
    },
    abandon: async ({ providerSandboxId, provider, destroyed }) => {
      if (destroyed) {
        await deleteSandboxInstance(claimed.record.id, claimed.record.orgId)
        return
      }
      await persistSandboxInstance({
        ...claimed.record,
        provider,
        providerSandboxId,
        state: "destroy_failed",
        lastHeartbeatAt: new Date(),
      })
    },
  })
  if (!created) return null
  try {
    await registerWorkspaceSandbox({
      id: claimed.record.id,
      kind: "job",
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      desiredUrl: input.desiredUrl,
      desiredSha: input.desiredSha,
      provider: created.provider,
      providerSandboxId: created.providerSandboxId ?? resumeId,
      handle: created.handle,
      destroy: created.destroy,
    })
  } catch (error) {
    let destroyed = false
    try {
      await created.destroy?.()
      destroyed = true
    } catch {
      destroyed = false
    }
    if (destroyed) {
      await deleteSandboxInstance(claimed.record.id, claimed.record.orgId)
    } else {
      await persistSandboxInstance({
        ...claimed.record,
        provider: created.provider,
        providerSandboxId: created.providerSandboxId ?? resumeId,
        state: "destroy_failed",
        lastHeartbeatAt: new Date(),
      })
    }
    throw error
  }
  return created.handle
}

type SandboxFactory = {
  create: (input: { id?: string }) => Promise<TanstackLikeHandle>
  resume?: (input: { id: string }) => Promise<TanstackLikeHandle | null>
}

type SandboxModules = {
  dockerSandbox?: (input: { image: string }) => SandboxFactory
  sbxSandbox?: () => SandboxFactory
  localProcessSandbox?: () => SandboxFactory
}

function jobProviderName(
  isolation: "docker" | "local_process" | string,
): "docker" | "sbx" | "local-process" {
  if (isolation === "sbx") return "sbx"
  return isolation === "docker" ? "docker" : "local-process"
}

function factoryForProvider(
  modules: SandboxModules,
  provider: string | null | undefined,
): SandboxFactory | undefined {
  if (provider === "docker") {
    return modules.dockerSandbox?.({ image: "node:22" })
  }
  if (provider === "sbx") {
    return modules.sbxSandbox?.()
  }
  if (provider === "local-process" || provider === "local_process") {
    return modules.localProcessSandbox?.()
  }
  return undefined
}

async function loadJobSandboxModules(): Promise<SandboxModules> {
  const [docker, local] = await Promise.all([
    import("@tanstack/ai-sandbox-docker").catch(() => null),
    import("@tanstack/ai-sandbox-local-process").catch(() => null),
  ])
  return {
    dockerSandbox: docker?.dockerSandbox,
    sbxSandbox: docker?.sbxSandbox,
    localProcessSandbox: local?.localProcessSandbox,
  }
}

async function seedJobRepo(
  handle: TanstackLikeHandle,
  input: {
    gitUrl: string
    ref: string
    cloneToken?: string | null
    fetchShas?: readonly string[]
  },
): Promise<void> {
  if (!handle.git) {
    throw new Error("Job sandbox has no git clone API")
  }
  await handle.git.clone({
    url: input.gitUrl,
    ref: input.ref,
    auth: input.cloneToken ? { token: input.cloneToken } : undefined,
    depth: 1,
  })
  for (const sha of input.fetchShas ?? []) {
    if (!/^[0-9a-f]{6,40}$/i.test(sha.trim())) continue
    const fetched = await handle.process.exec(
      `git fetch --depth=1 origin ${sha.trim()}`,
    )
    if (fetched.exitCode !== 0) {
      throw new Error(fetched.stderr || `missing commit ${sha}`)
    }
  }
  await handle.process.exec(scrubOriginAfterCloneCommand(input.gitUrl))
}

export async function createTanstackJobSandbox(input: {
  sandboxId: string
  gitUrl: string
  ref: string
  cloneToken?: string | null
  fetchShas?: readonly string[]
  env?: Record<string, string | undefined>
  loadModules?: () => Promise<SandboxModules>
  persistProviderId?: JobSandboxCreateHooks["persistLive"]
  abandonCreated?: JobSandboxCreateHooks["abandon"]
  storedProvider?: string | null
}): Promise<{
  handle: JobSandboxHandle
  destroy: () => Promise<void>
  providerSandboxId: string
  provider: string
} | null> {
  const modules = await (input.loadModules ?? loadJobSandboxModules)()
  const provider = detectSandboxProviderFromEnv({ env: input.env })
  const isolation = resolveJobSandboxIsolation({
    provider,
    hasDocker: Boolean(modules.dockerSandbox),
  })
  if (!isolation) {
    throw new SandboxProviderUnavailableError(provider)
  }
  const providerName = jobProviderName(isolation)
  const factory = factoryForProvider(modules, providerName)
  if (!factory) {
    throw new SandboxProviderUnavailableError(providerName)
  }
  const storedProvider = input.storedProvider ?? undefined
  const storedMatches = jobProviderMatchesEffective(
    storedProvider,
    providerName,
  )
  if (input.sandboxId && storedProvider && storedMatches) {
    const storedFactory = factoryForProvider(modules, storedProvider)
    const resumed = storedFactory
      ? await storedFactory.resume?.({ id: input.sandboxId })
      : null
    if (resumed) {
      return {
        handle: adaptTanstackHandle(resumed),
        destroy: () => resumed.destroy(),
        providerSandboxId: resumed.id ?? input.sandboxId,
        provider: providerName,
      }
    }
  }
  if (input.sandboxId && storedProvider && !storedMatches) {
    await destroyDetachedProviderSandbox({
      provider: storedProvider,
      providerSandboxId: input.sandboxId,
    })
  } else if (input.sandboxId && storedMatches) {
    const resumed = await factory.resume?.({ id: input.sandboxId })
    if (resumed) {
      return {
        handle: adaptTanstackHandle(resumed),
        destroy: () => resumed.destroy(),
        providerSandboxId: resumed.id ?? input.sandboxId,
        provider: providerName,
      }
    }
  }
  const raw = await factory.create({})
  if (!raw.id) {
    await raw.destroy().catch(() => undefined)
    throw new Error("Job sandbox create did not return a provider id")
  }
  try {
    await input.persistProviderId?.({
      providerSandboxId: raw.id,
      provider: providerName,
    })
    await seedJobRepo(raw, input)
  } catch (error) {
    let destroyed = false
    try {
      await raw.destroy()
      destroyed = true
    } catch {
      destroyed = false
    }
    await input.abandonCreated?.({
      providerSandboxId: raw.id,
      provider: providerName,
      destroyed,
    })
    throw error
  }
  return {
    handle: adaptTanstackHandle(raw),
    destroy: () => raw.destroy(),
    providerSandboxId: raw.id,
    provider: providerName,
  }
}
