import {
  CHAT_PERMISSION_MODE,
  CHAT_SANDBOX_LIMITS,
  createWorkspaceChatPermissionHandler,
  judgeChatToolWithFastModel,
} from "./chat-sandbox-policy.js"
import { sandboxSnapshotKey } from "./revision.js"
import {
  detectSandboxProviderFromEnv,
  sandboxMustFailClosed,
} from "./sandbox-provider.js"
import { WORKSPACE_CHAT_OPENCODE_CLI } from "./workspace-chat-opencode-contract.js"

/** Locked product chat path: TanStack `chat()` + `withSandbox` + `opencodeText`. */
export const WORKSPACE_CHAT_RUNTIME = {
  transport: "tanstack_chat",
  sandbox: "withSandbox",
  harness: "opencodeText",
  permissionMode: CHAT_PERMISSION_MODE,
  limits: CHAT_SANDBOX_LIMITS,
} as const

/** Port `opencode serve` binds inside the sandbox. Docker must publish it. */
export const WORKSPACE_CHAT_OPENCODE_PORT = 4096

export const WORKSPACE_CHAT_DOCKER_SANDBOX: {
  image: string
  publishPorts: number[]
} = {
  image: "node:22",
  publishPorts: [WORKSPACE_CHAT_OPENCODE_PORT],
}

/**
 * Bootstrap must leave `opencode` on PATH. TanStack's adapter spawns
 * `opencode serve` inside the sandbox; `node:22` and a host without the CLI
 * both miss that binary.
 */
export const WORKSPACE_CHAT_SANDBOX_SETUP = [
  `command -v opencode >/dev/null 2>&1 || npm install -g ${WORKSPACE_CHAT_OPENCODE_CLI}`,
] as const

export function workspaceChatSandboxId(input: {
  orgId: string
  workspaceId: string
  desiredUrl: string
  desiredSha: string | null
  image: string
}): string | null {
  const snapshot = sandboxSnapshotKey(input.desiredUrl, input.desiredSha)
  if (!snapshot) return null
  return `${input.orgId}:${input.workspaceId}:${snapshot}:${input.image}`
}

export const CHAT_SANDBOX_KEEP_ALIVE = "30m" as const

export function workspaceChatLiveSandboxId(input: {
  snapshotId: string
  conversationId: string
}): string {
  return `${input.snapshotId}:thread:${input.conversationId}`
}

/** Clone auth is not part of the sandbox id — rotating the token must not bust the snapshot. */
export function workspaceChatGitSource(input: {
  url: string
  ref: string
  token?: string | null
}): { url: string; ref: string; auth?: { token: string } } {
  if (!input.token) return { url: input.url, ref: input.ref }
  return { url: input.url, ref: input.ref, auth: { token: input.token } }
}

export function workspaceChatSandboxSpec(input: {
  sandboxId: string
  provider: ReturnType<typeof detectSandboxProviderFromEnv>
  gitUrl: string
  ref: string
}):
  | {
      ok: true
      id: string
      isolation: "docker" | "local_process"
      source: { type: "git"; url: string; ref: string }
      lifecycle: {
        reuse: "thread"
        snapshot: "after-setup"
        keepAlive: typeof CHAT_SANDBOX_KEEP_ALIVE
      }
    }
  | { ok: false; reason: "no_isolated_provider" } {
  if (input.provider === "railway") {
    return { ok: false, reason: "no_isolated_provider" }
  }
  return {
    ok: true,
    id: input.sandboxId,
    isolation: input.provider === "docker" ? "docker" : "local_process",
    source: { type: "git", url: input.gitUrl, ref: input.ref },
    lifecycle: {
      reuse: "thread",
      snapshot: "after-setup",
      keepAlive: CHAT_SANDBOX_KEEP_ALIVE,
    },
  }
}

export function workspaceChatRuntimeConfig(input?: {
  hasSbx?: boolean
  hasDocker?: boolean
  env?: Record<string, string | undefined>
  writeStatus?: string
  judge?: (
    toolName: string,
    argsExcerpt: string,
  ) => Promise<"allow" | "deny" | "timeout" | "garbage">
}) {
  const provider = detectSandboxProviderFromEnv({
    hasSbx: input?.hasSbx,
    hasDocker: input?.hasDocker,
    env: input?.env,
  })
  return {
    ...WORKSPACE_CHAT_RUNTIME,
    provider,
    failClosed: sandboxMustFailClosed({
      provider,
      canEnforceLimits: true,
    }),
    onPermissionRequest: createWorkspaceChatPermissionHandler({
      writeStatus: input?.writeStatus ?? "read_only",
      judge: input?.judge ?? judgeChatToolWithFastModel,
    }),
  }
}
