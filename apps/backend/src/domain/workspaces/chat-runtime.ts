import {
  CHAT_PERMISSION_MODE,
  createWorkspaceChatPermissionHandler,
  judgeChatToolWithFastModel,
} from "./chat-sandbox-policy.js"
import { sandboxSnapshotKey } from "./revision.js"
import { detectSandboxProviderFromEnv } from "./sandbox-provider.js"
import { WORKSPACE_CHAT_OPENCODE_CLI } from "./workspace-chat-opencode-contract.js"

/** Locked product chat path: TanStack `chat()` + `withSandbox` + `opencodeText`. */
export const WORKSPACE_CHAT_RUNTIME = {
  transport: "tanstack_chat",
  sandbox: "withSandbox",
  harness: "opencodeText",
  permissionMode: CHAT_PERMISSION_MODE,
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
  `PATH="/usr/local/bin:/usr/bin:/bin:$PATH"; command -v opencode >/dev/null 2>&1 || npm install -g ${WORKSPACE_CHAT_OPENCODE_CLI}`,
  // TanStack drives setup on a persistent `sh` (`{ $command ; } 2>&1; printf
  // sentinel`). `exit` / `set -e` kill that shell before the sentinel. End
  // on `true` so dash accepts the wrapper's trailing `;`.
  `if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  true
else
  DEST=/tmp/ctxpipe-repo-clone
  rm -rf "$DEST"
  clone_repo() {
    if [ -n "\${CTXPIPE_CLONE_TOKEN:-}" ]; then
      git -c credential.helper='!f() { echo username=x-access-token; echo password=\${CTXPIPE_CLONE_TOKEN}; }; f' "$@"
    else
      git "$@"
    fi
  }
  if ! clone_repo clone --depth 1 --single-branch --branch "$CTXPIPE_CLONE_BRANCH" -- "$CTXPIPE_CLONE_URL" "$DEST"; then
    clone_repo clone --depth 1 -- "$CTXPIPE_CLONE_URL" "$DEST"
  fi
  cp -a "$DEST"/. .
  if [ -n "\${CTXPIPE_CLONE_SHA:-}" ]; then
    git fetch --depth 1 origin "$CTXPIPE_CLONE_SHA" && git checkout --detach "$CTXPIPE_CLONE_SHA" || true
  fi
  git rev-parse --is-inside-work-tree >/dev/null
fi
true`,
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

export const WORKSPACE_CHAT_CLONE_TOKEN_SECRET = "CTXPIPE_CLONE_TOKEN" as const
export const WORKSPACE_CHAT_CLONE_URL_SECRET = "CTXPIPE_CLONE_URL" as const
export const WORKSPACE_CHAT_CLONE_BRANCH_SECRET = "CTXPIPE_CLONE_BRANCH" as const
export const WORKSPACE_CHAT_CLONE_SHA_SECRET = "CTXPIPE_CLONE_SHA" as const

/**
 * Bind a TanStack SecretRef so JSON hashing sees only `{ __secretName }`,
 * while `String(ref)` (Node child env) still yields the live token.
 */
export function bindWorkspaceChatSecretRef(
  ref: { readonly __secretName: string },
  value: string,
): { readonly __secretName: string } {
  return Object.create(null, {
    __secretName: { value: ref.__secretName, enumerable: true },
    toString: { value: () => value, enumerable: false },
    valueOf: { value: () => value, enumerable: false },
  })
}

export function workspaceChatCloneTokenRef(
  secrets: Record<string, unknown>,
  token: string | null | undefined,
): { readonly __secretName: string } | null {
  if (!token) return null
  const ref = secrets[WORKSPACE_CHAT_CLONE_TOKEN_SECRET]
  const named =
    ref && typeof ref === "object" && "__secretName" in ref
      ? (ref as { readonly __secretName: string })
      : { __secretName: WORKSPACE_CHAT_CLONE_TOKEN_SECRET }
  return bindWorkspaceChatSecretRef(named, token)
}

/** Clone auth is a SecretRef (or omitted). Plaintext tokens must not enter the workspace hash. */
export function workspaceChatGitSource(input: {
  url: string
  ref: string
  token?: { readonly __secretName: string } | null
}): {
  url: string
  ref: string
  auth?: { token: { readonly __secretName: string } }
} {
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
      isolation: "docker" | "unsandboxed" | "railway"
      source: { type: "git"; url: string; ref: string }
      lifecycle: {
        reuse: "thread"
        snapshot: "after-setup"
        keepAlive: typeof CHAT_SANDBOX_KEEP_ALIVE
        destroyOnComplete: false
      }
    }
  | { ok: false; reason: "no_isolated_provider" } {
  if (
    input.provider !== "docker" &&
    input.provider !== "unsandboxed" &&
    input.provider !== "railway"
  ) {
    return { ok: false, reason: "no_isolated_provider" }
  }
  return {
    ok: true,
    id: input.sandboxId,
    isolation: input.provider,
    source: { type: "git", url: input.gitUrl, ref: input.ref },
    lifecycle: {
      reuse: "thread",
      snapshot: "after-setup",
      keepAlive: CHAT_SANDBOX_KEEP_ALIVE,
      destroyOnComplete: false,
    },
  }
}

export function workspaceChatRuntimeConfig(input?: {
  hasSbx?: boolean
  hasDocker?: boolean
  env?: Record<string, string | undefined>
  writeStatus?: string
  currentBranch?: string | null
  defaultBranch?: string | null
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
    onPermissionRequest: createWorkspaceChatPermissionHandler({
      writeStatus: input?.writeStatus ?? "read_only",
      currentBranch: input?.currentBranch,
      defaultBranch: input?.defaultBranch,
      judge: input?.judge ?? judgeChatToolWithFastModel,
    }),
  }
}
