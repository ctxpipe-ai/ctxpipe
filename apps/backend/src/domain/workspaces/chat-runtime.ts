import {
  CHAT_PERMISSION_MODE,
  createWorkspaceChatPermissionHandler,
  judgeChatToolWithFastModel,
} from "./chat-sandbox-policy.js"
import { CONVERSATION_SANDBOX_GIT_EXCLUDE_LINES } from "./conversation-files.js"
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

/** The prebuilt agent image selected for this deployment. */
export function workspaceChatDockerImage(): string {
  return (
    process.env.SANDBOX_CHAT_IMAGE?.trim() ||
    "ctxpipe-chat-sandbox:opencode-1.18.34-r4"
  )
}

/**
 * Bootstrap must leave `opencode` on PATH. TanStack's adapter spawns
 * `opencode serve` inside the sandbox; `node:24` and a host without the CLI
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
 * The repository-size cap of an AgentCore sandbox (CTX-1219). A session has
 * a 9.8 GB disk with about 7 GB free (spike CTX-1213). The check runs as the
 * last setup step, after the clone, the fetch of the desired commit and the
 * session branch: a checkout that uses more than 6 GB, or that leaves less
 * than 512 MB free, fails the setup with a clear message, before the agent
 * fills the disk. A clone or a fetch that fills the disk first fails with
 * the provider's disk-full message (`agentcore-sandbox-provider.ts`).
 */
export function agentCoreSizeCapCommand(capGb = 6, minFreeMb = 512): string {
  return `used_kb=$(du -sk . 2>/dev/null | cut -f1)
free_kb=$(df -Pk . | awk 'NR == 2 { print $4 }')
if [ "\${used_kb:-0}" -gt ${Math.round(capGb * 1024 * 1024)} ] || [ "\${free_kb:-0}" -lt ${minFreeMb * 1024} ]; then
  echo "This repository is too large for a hosted sandbox: its checkout uses $(( \${used_kb:-0} / 1024 )) MB, and the limit is ${capGb} GB."
  exit 1
fi`
}

/**
 * `git` with the sandbox's read credential (the clone token; empty where
 * Agent Vault adds it). It can never push. The empty helper first
 * removes the other helpers, so no keychain stores or prompts for the token.
 */
export const SANDBOX_READ_GIT = `git -c credential.helper= -c credential.helper='!f() { echo username=x-access-token; echo password=\${CTXPIPE_CLONE_TOKEN}; }; f'`

/** The author and committer of the commits ctxpipe makes in a sandbox. */
export const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: "ctxpipe",
  GIT_AUTHOR_EMAIL: "workspace-chat@ctxpipe.local",
  GIT_COMMITTER_NAME: "ctxpipe",
  GIT_COMMITTER_EMAIL: "workspace-chat@ctxpipe.local",
}

/**
 * Checks out the conversation: the desired commit, then its session branch if
 * published. `refs/remotes/ctxpipe/base` marks the default commit the sandbox
 * builds on, so commits no remote-tracking ref covers are the unpushed ones.
 */
export const WORKSPACE_CHAT_THREAD_SETUP = [
  `(git rev-parse --git-dir >/dev/null 2>&1 || {
  # The stock clone does not report its failure: ask the remote again, so the
  # setup error (which shows stdout) says why. Git's output names no credential.
  echo "Workspace clone failed: $CTXPIPE_CLONE_URL"
  git ls-remote --heads -- "$CTXPIPE_CLONE_URL" 2>&1 | tail -n 5
  exit 1
}
# The stock clone is shallow; fetch the desired commit when the tip has moved on.
git cat-file -e "$CTXPIPE_CLONE_SHA^{commit}" 2>/dev/null ||
  ${SANDBOX_READ_GIT} fetch --depth 1 origin "$CTXPIPE_CLONE_SHA" || exit 1
git checkout -B "$CTXPIPE_CLONE_BRANCH" "$CTXPIPE_CLONE_SHA" &&
git update-ref refs/remotes/ctxpipe/base "$CTXPIPE_CLONE_SHA" &&
# The agent commits with plain git, and the sandbox has no identity.
git config user.name ${COMMIT_IDENTITY.GIT_AUTHOR_NAME} &&
git config user.email ${COMMIT_IDENTITY.GIT_AUTHOR_EMAIL} &&
if [ -n "\${CTXPIPE_SESSION_BRANCH:-}" ]; then
  git check-ref-format "refs/heads/$CTXPIPE_SESSION_BRANCH" || exit 1
  ${SANDBOX_READ_GIT} ls-remote --exit-code --heads origin "refs/heads/$CTXPIPE_SESSION_BRANCH" >/dev/null
  REMOTE_STATUS=$?
  if [ "$REMOTE_STATUS" = 0 ]; then
    ${SANDBOX_READ_GIT} fetch --depth 1 origin "+refs/heads/$CTXPIPE_SESSION_BRANCH:refs/remotes/origin/$CTXPIPE_SESSION_BRANCH" &&
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

export const WORKSPACE_CHAT_CLONE_TOKEN_SECRET = "CTXPIPE_CLONE_TOKEN" as const
export const WORKSPACE_CHAT_CLONE_URL_SECRET = "CTXPIPE_CLONE_URL" as const
export const WORKSPACE_CHAT_CLONE_BRANCH_SECRET =
  "CTXPIPE_CLONE_BRANCH" as const
export const WORKSPACE_CHAT_CLONE_SHA_SECRET = "CTXPIPE_CLONE_SHA" as const
export const WORKSPACE_CHAT_SESSION_BRANCH_SECRET =
  "CTXPIPE_SESSION_BRANCH" as const

export function workspaceChatRuntimeConfig(input?: {
  writeStatus?: string
  currentBranch?: string | null
  getCurrentBranch?: () => Promise<string>
  defaultBranch?: string | null
  /** Hosted sandboxes: see `classifyChatToolRequest`. */
  openNetwork?: boolean
  judge?: (
    toolName: string,
    argsExcerpt: string,
  ) => Promise<"allow" | "deny" | "timeout" | "garbage">
}) {
  return {
    ...WORKSPACE_CHAT_RUNTIME,
    onPermissionRequest: createWorkspaceChatPermissionHandler({
      writeStatus: input?.writeStatus ?? "read_only",
      currentBranch: input?.currentBranch,
      getCurrentBranch: input?.getCurrentBranch,
      defaultBranch: input?.defaultBranch,
      openNetwork: input?.openNetwork,
      judge: input?.judge ?? judgeChatToolWithFastModel,
    }),
  }
}
