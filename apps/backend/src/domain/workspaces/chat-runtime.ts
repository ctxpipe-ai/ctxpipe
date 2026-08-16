import {
  CHAT_PERMISSION_MODE,
  CHAT_SANDBOX_LIMITS,
  createWorkspaceChatPermissionHandler,
} from "./chat-sandbox-policy.js"
import { sandboxSnapshotKey } from "./revision.js"
import {
  detectSandboxProviderFromEnv,
  sandboxMustFailClosed,
} from "./sandbox-provider.js"

/** Locked product chat path: TanStack `chat()` + `withSandbox` + `opencodeText`. */
export const WORKSPACE_CHAT_RUNTIME = {
  transport: "tanstack_chat",
  sandbox: "withSandbox",
  harness: "opencodeText",
  permissionMode: CHAT_PERMISSION_MODE,
  limits: CHAT_SANDBOX_LIMITS,
} as const

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

export function workspaceChatRuntimeConfig(input?: {
  hasSbx?: boolean
  hasDocker?: boolean
  env?: Record<string, string | undefined>
  writeStatus?: string
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
    }),
  }
}
