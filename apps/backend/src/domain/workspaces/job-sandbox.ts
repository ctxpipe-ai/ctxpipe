import { claimSandboxInstance } from "../../models/workspaces.js"
import { scrubOriginAfterCloneCommand } from "./clone-credentials.js"
import type { JobSandboxHandle, JobWorktreeExec } from "./job-worktree.js"
import { withSandboxAdvisoryLock } from "./sandbox-instance-store.js"
import {
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

export function jobSandboxIsolation(
  provider: SandboxProvider,
): "docker" | "local_process" {
  return provider === "docker" ? "docker" : "local_process"
}

/** Locked docker/railway fail closed. Unset/unsandboxed may use local-process. */
export function resolveJobSandboxIsolation(input: {
  provider: SandboxProvider
  hasDocker: boolean
  hasLocal: boolean
}): "docker" | "local_process" | null {
  if (input.provider === "docker") {
    return input.hasDocker ? "docker" : null
  }
  if (input.provider === "railway") return null
  if (input.hasLocal) return "local_process"
  return null
}

export function adaptTanstackHandle(
  handle: TanstackLikeHandle,
): JobSandboxHandle {
  return {
    exec: (command, options) => handle.process.exec(command, options),
    fs: handle.fs,
  }
}

export async function ensureJobSandbox(input: {
  orgId: string
  workspaceId: string
  desiredUrl: string
  desiredSha: string | null
  existing?: JobSandboxHandle | null
  create: (sandboxId: string) => Promise<{
    handle: JobSandboxHandle
    destroy?: () => Promise<void>
    providerSandboxId?: string
  } | null>
}): Promise<JobSandboxHandle | null> {
  if (input.existing) return input.existing
  const attached = getJobSandbox(input.workspaceId)
  if (attached) return attached
  return withSandboxAdvisoryLock(
    `sandbox:job:${input.workspaceId}`,
    async () => {
      const attachedInside = getJobSandbox(input.workspaceId)
      if (attachedInside) return attachedInside
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
      const resumeId = claimed.record.providerSandboxId ?? claimed.record.id
      const created = await input.create(resumeId)
      if (!created) return null
      await registerWorkspaceSandbox({
        id: claimed.record.id,
        kind: "job",
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        desiredUrl: input.desiredUrl,
        desiredSha: input.desiredSha,
        providerSandboxId: created.providerSandboxId ?? resumeId,
        handle: created.handle,
        destroy: created.destroy,
      })
      return created.handle
    },
  )
}

type SandboxFactory = {
  create: (input: { id?: string }) => Promise<TanstackLikeHandle>
  resume?: (input: { id: string }) => Promise<TanstackLikeHandle | null>
}

type SandboxModules = {
  dockerSandbox?: (input: { image: string }) => SandboxFactory
  localProcessSandbox?: () => SandboxFactory
}

async function loadJobSandboxModules(): Promise<SandboxModules> {
  const [docker, local] = await Promise.all([
    import("@tanstack/ai-sandbox-docker").catch(() => null),
    import("@tanstack/ai-sandbox-local-process").catch(() => null),
  ])
  return {
    dockerSandbox: docker?.dockerSandbox,
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
}): Promise<{
  handle: JobSandboxHandle
  destroy: () => Promise<void>
  providerSandboxId: string
} | null> {
  const modules = await (input.loadModules ?? loadJobSandboxModules)()
  const provider = detectSandboxProviderFromEnv({ env: input.env })
  const isolation = resolveJobSandboxIsolation({
    provider,
    hasDocker: Boolean(modules.dockerSandbox),
    hasLocal: Boolean(modules.localProcessSandbox),
  })
  if (!isolation) return null
  const factory =
    isolation === "docker"
      ? modules.dockerSandbox?.({ image: "node:22" })
      : modules.localProcessSandbox?.()
  if (!factory) return null
  const resumed = input.sandboxId
    ? await factory.resume?.({ id: input.sandboxId })
    : null
  if (resumed) {
    return {
      handle: adaptTanstackHandle(resumed),
      destroy: () => resumed.destroy(),
      providerSandboxId: resumed.id ?? input.sandboxId,
    }
  }
  const raw = await factory.create({})
  await seedJobRepo(raw, input)
  if (!raw.id) {
    throw new Error("Job sandbox create did not return a provider id")
  }
  return {
    handle: adaptTanstackHandle(raw),
    destroy: () => raw.destroy(),
    providerSandboxId: raw.id,
  }
}
