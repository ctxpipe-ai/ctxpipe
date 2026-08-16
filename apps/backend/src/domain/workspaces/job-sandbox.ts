import type { JobSandboxHandle, JobWorktreeExec } from "./job-worktree.js"
import {
  detectSandboxProviderFromEnv,
  type SandboxProvider,
} from "./sandbox-provider.js"
import { getJobSandbox, registerWorkspaceSandbox } from "./sandbox-registry.js"
import { workspaceWriteSandboxId } from "./write-runner.js"

export type TanstackLikeHandle = {
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

/** Jobs fall back to in-process when Docker is missing. Chat lock still fails closed. */
export function resolveJobSandboxIsolation(input: {
  provider: SandboxProvider
  hasDocker: boolean
  hasLocal: boolean
}): "docker" | "local_process" | null {
  const requested = jobSandboxIsolation(input.provider)
  if (requested === "docker" && input.hasDocker) return "docker"
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
  create: () => Promise<{
    handle: JobSandboxHandle
    destroy?: () => Promise<void>
  } | null>
}): Promise<JobSandboxHandle | null> {
  if (input.existing) return input.existing
  const attached = getJobSandbox(input.workspaceId)
  if (attached) return attached
  const created = await input.create()
  if (!created) return null
  const id =
    workspaceWriteSandboxId({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      desiredUrl: input.desiredUrl,
      desiredSha: input.desiredSha,
    }) ?? `${input.orgId}:${input.workspaceId}:write`
  registerWorkspaceSandbox({
    id,
    kind: "job",
    workspaceId: input.workspaceId,
    handle: created.handle,
    destroy: created.destroy,
  })
  return created.handle
}

type SandboxModules = {
  dockerSandbox?: (input: { image: string }) => {
    create: (input: { id?: string }) => Promise<TanstackLikeHandle>
  }
  localProcessSandbox?: () => {
    create: (input: { id?: string }) => Promise<TanstackLikeHandle>
  }
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
  },
): Promise<void> {
  try {
    if (handle.git) {
      await handle.git.clone({
        url: input.gitUrl,
        ref: input.ref,
        auth: input.cloneToken ? { token: input.cloneToken } : undefined,
        depth: 1,
      })
      return
    }
  } catch {
    // Fall through to an empty repo so worktree add still has HEAD.
  }
  await handle.process.exec("git init")
  await handle.process.exec("git commit --allow-empty -m ctxpipe-job-sandbox")
}

export async function createTanstackJobSandbox(input: {
  sandboxId: string
  gitUrl: string
  ref: string
  cloneToken?: string | null
  env?: Record<string, string | undefined>
  loadModules?: () => Promise<SandboxModules>
}): Promise<{
  handle: JobSandboxHandle
  destroy: () => Promise<void>
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
  const raw = await factory.create({ id: input.sandboxId })
  await seedJobRepo(raw, input)
  return {
    handle: adaptTanstackHandle(raw),
    destroy: () => raw.destroy(),
  }
}
