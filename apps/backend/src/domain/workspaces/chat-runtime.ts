import {
  CHAT_PERMISSION_MODE,
  createWorkspaceChatPermissionHandler,
  judgeChatToolWithFastModel,
} from "./chat-sandbox-policy.js"
import { CONVERSATION_SANDBOX_GIT_EXCLUDE_LINES } from "./conversation-files.js"
import { detectSandboxProviderFromEnv } from "./sandbox-provider.js"
import {
  VERCEL_AGENT_ROOT,
  WORKSPACE_CHAT_OPENCODE_CLI,
} from "./workspace-chat-opencode-contract.js"

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
  image:
    "node@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d",
  publishPorts: [WORKSPACE_CHAT_OPENCODE_PORT],
}

/** The prebuilt agent image selected for this deployment. */
export function workspaceChatDockerImage(): string {
  return (
    process.env.SANDBOX_CHAT_IMAGE?.trim() ||
    "ctxpipe-chat-sandbox:opencode-1.18.34"
  )
}

/**
 * Bootstrap must leave `opencode` on PATH. TanStack's adapter spawns
 * `opencode serve` inside the sandbox; `node:22` and a host without the CLI
 * both miss that binary.
 */
export const WORKSPACE_CHAT_SANDBOX_SETUP = [
  `PATH="/usr/local/bin:/usr/bin:/bin:$PATH"; command -v opencode >/dev/null 2>&1 || npm install -g ${WORKSPACE_CHAT_OPENCODE_CLI}`,
  `if git rev-parse --git-dir >/dev/null 2>&1; then
  EXCLUDE="$(git rev-parse --git-dir)/info/exclude"
  mkdir -p "$(dirname "$EXCLUDE")"
  for line in ${CONVERSATION_SANDBOX_GIT_EXCLUDE_LINES.map((line) => JSON.stringify(line)).join(" ")}; do
    grep -qxF "$line" "$EXCLUDE" 2>/dev/null || printf '%s\\n' "$line" >> "$EXCLUDE"
  done
fi
true`,
] as const

/** Docker images are initialized at deployment, never installed during a turn. */
export const WORKSPACE_CHAT_DOCKER_SETUP = [
  `PATH="/usr/local/bin:/usr/bin:/bin:$PATH"; command -v opencode >/dev/null 2>&1`,
  ...WORKSPACE_CHAT_SANDBOX_SETUP.slice(1),
] as const

/**
 * Vercel's `node24` runtime has no OpenCode, and its user cannot write the
 * global npm prefix, so the CLI goes under the user's home (kept on stop).
 * The Workspace base snapshot (ticket 02) will carry it instead.
 */
export const WORKSPACE_CHAT_VERCEL_SETUP = [
  `command -v opencode >/dev/null 2>&1 || npm install -g --prefix "${VERCEL_AGENT_ROOT}/.local" ${WORKSPACE_CHAT_OPENCODE_CLI}`,
  ...WORKSPACE_CHAT_SANDBOX_SETUP.slice(1),
] as const

/** Checks out the conversation: the desired commit, then its session branch if published. */
export const WORKSPACE_CHAT_THREAD_SETUP = [
  `(git rev-parse --git-dir >/dev/null 2>&1 || { echo "Workspace clone failed: $CTXPIPE_CLONE_URL" >&2; exit 1; }
# The stock clone is shallow; fetch the desired commit when the tip has moved on.
git cat-file -e "$CTXPIPE_CLONE_SHA^{commit}" 2>/dev/null ||
  git -c credential.helper='!f() { echo username=x-access-token; echo password=\${CTXPIPE_CLONE_TOKEN}; }; f' fetch --depth 1 origin "$CTXPIPE_CLONE_SHA" || exit 1
git checkout -B "$CTXPIPE_CLONE_BRANCH" "$CTXPIPE_CLONE_SHA" &&
if [ -n "\${CTXPIPE_SESSION_BRANCH:-}" ]; then
  git check-ref-format "refs/heads/$CTXPIPE_SESSION_BRANCH" || exit 1
  git -c credential.helper='!f() { echo username=x-access-token; echo password=\${CTXPIPE_CLONE_TOKEN}; }; f' ls-remote --exit-code --heads origin "refs/heads/$CTXPIPE_SESSION_BRANCH" >/dev/null
  REMOTE_STATUS=$?
  if [ "$REMOTE_STATUS" = 0 ]; then
    git -c credential.helper='!f() { echo username=x-access-token; echo password=\${CTXPIPE_CLONE_TOKEN}; }; f' fetch --depth 1 origin "+refs/heads/$CTXPIPE_SESSION_BRANCH:refs/remotes/origin/$CTXPIPE_SESSION_BRANCH" &&
    git checkout -B "$CTXPIPE_SESSION_BRANCH" FETCH_HEAD || exit 1
  elif [ "$REMOTE_STATUS" != 2 ]; then
    exit "$REMOTE_STATUS"
  fi
fi)`,
  `OPENCODE_HOME="\${HOME:-/tmp/ctxpipe-opencode-home}"
mkdir -p "$OPENCODE_HOME"
if [ -n "\${CTXPIPE_OPENCODE_JSON:-}" ]; then
  printf '%s\\n' "$CTXPIPE_OPENCODE_JSON" > "$OPENCODE_HOME/opencode.json"
fi
true`,
] as const

/** A hint only; the conversation sandbox sweep stops idle sandboxes. */
export const CHAT_SANDBOX_KEEP_ALIVE = "5m" as const

export const WORKSPACE_CHAT_CLONE_TOKEN_SECRET = "CTXPIPE_CLONE_TOKEN" as const
export const WORKSPACE_CHAT_CLONE_URL_SECRET = "CTXPIPE_CLONE_URL" as const
export const WORKSPACE_CHAT_CLONE_BRANCH_SECRET =
  "CTXPIPE_CLONE_BRANCH" as const
export const WORKSPACE_CHAT_CLONE_SHA_SECRET = "CTXPIPE_CLONE_SHA" as const
export const WORKSPACE_CHAT_SESSION_BRANCH_SECRET =
  "CTXPIPE_SESSION_BRANCH" as const

export function workspaceChatRuntimeConfig(input?: {
  hasDocker?: boolean
  env?: Record<string, string | undefined>
  writeStatus?: string
  currentBranch?: string | null
  getCurrentBranch?: () => Promise<string>
  defaultBranch?: string | null
  judge?: (
    toolName: string,
    argsExcerpt: string,
  ) => Promise<"allow" | "deny" | "timeout" | "garbage">
}) {
  const provider = detectSandboxProviderFromEnv({
    hasDocker: input?.hasDocker,
    env: input?.env,
  })
  return {
    ...WORKSPACE_CHAT_RUNTIME,
    provider,
    onPermissionRequest: createWorkspaceChatPermissionHandler({
      writeStatus: input?.writeStatus ?? "read_only",
      currentBranch: input?.currentBranch,
      getCurrentBranch: input?.getCurrentBranch,
      defaultBranch: input?.defaultBranch,
      judge: input?.judge ?? judgeChatToolWithFastModel,
    }),
  }
}
