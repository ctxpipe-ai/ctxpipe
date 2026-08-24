import { withOrgDbContext } from "../../db/client.js"
import {
  deleteSandboxInstance,
  listSandboxInstances,
} from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import { originUrlWithoutCredentials } from "./clone-credentials.js"
import type { TanstackLikeHandle } from "./job-sandbox.js"
import { clearWorkspaceChatOpenCodeSessionId } from "./workspace-chat-opencode-session.js"

type ExecResult = { stdout: string; stderr: string; exitCode: number }

async function sandboxExec(
  handle: TanstackLikeHandle,
  command: string,
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<ExecResult> {
  const exec = handle.process?.exec
  if (!exec) {
    throw new Error("Chat sandbox handle cannot exec")
  }
  return exec(command, options)
}

const CHAT_SANDBOX_CLONE_SCRIPT = `set -e
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi
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
`

/**
 * TanStack git-exec clone ignores a non-zero exit and `--branch` a SHA fails.
 * Clone into a temp dir (workdir already has opencode.json) and copy in.
 * Token stays in env, never argv.
 */
export async function ensureChatSandboxCheckout(input: {
  handle: TanstackLikeHandle
  repoUrl: string
  defaultBranch: string
  desiredSha?: string | null
}): Promise<void> {
  const repoUrl = originUrlWithoutCredentials(input.repoUrl).trim()
  if (!repoUrl) {
    throw new Error("workspace chat git clone failed: missing repository URL")
  }
  const result = await sandboxExec(input.handle, CHAT_SANDBOX_CLONE_SCRIPT, {
    env: {
      CTXPIPE_CLONE_URL: repoUrl,
      CTXPIPE_CLONE_BRANCH: input.defaultBranch.trim() || "main",
      CTXPIPE_CLONE_SHA: input.desiredSha?.trim() ?? "",
    },
  })
  if (result.exitCode !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter((part) => part.trim())
      .join("\n")
      .slice(0, 400)
    throw new Error(
      detail
        ? `workspace chat git clone failed: ${detail}`
        : "workspace chat git clone failed",
    )
  }
}

export async function preflightChatSandbox(input: {
  handle: TanstackLikeHandle
  isolation: "docker" | "local_process"
  proxyUrl: string
  stalePort?: number
}): Promise<void> {
  // Isolation and proxyUrl stay on the public input so callers keep passing
  // them. Proxy reachability is already self-checked from the backend
  // process — do not curl /v1/models from inside the sandbox. Railway and
  // sbx images often lack curl (exit 127), which failed every PR chat turn.
  void input.isolation
  void input.proxyUrl
  if (input.stalePort != null) {
    const stale = await sandboxExec(
      input.handle,
      `sh -c 'if command -v ss >/dev/null 2>&1; then ss -lnt | grep -q ":${input.stalePort}"; elif command -v nc >/dev/null 2>&1; then nc -z 127.0.0.1 ${input.stalePort}; else exit 1; fi'`,
    )
    if (stale.exitCode === 0) {
      throw new Error(
        `Chat sandbox still has a listener on port ${input.stalePort}`,
      )
    }
  }
  const cli = await sandboxExec(
    input.handle,
    "sh -c 'command -v opencode >/dev/null'",
  )
  if (cli.exitCode !== 0) {
    getLogger().warn("OpenCode CLI was not on PATH during sandbox ready", {
      step: "chat-sandbox-preflight",
    })
  }
  const git = await sandboxExec(
    input.handle,
    "sh -c 'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || test -d .git || test -f .git'",
  )
  if (git.exitCode !== 0) {
    getLogger().warn("Sandbox workdir did not look like a git checkout", {
      step: "chat-sandbox-preflight",
    })
  }
  void input.proxyUrl
}

export async function invalidateChatSandbox(input: {
  handle?: TanstackLikeHandle | null
  orgId: string
  conversationId: string
}): Promise<void> {
  clearWorkspaceChatOpenCodeSessionId(input.conversationId)
  if (input.handle) {
    await input.handle.destroy().catch((error) => {
      getLogger().error(
        error instanceof Error ? error : new Error(String(error)),
        { step: "invalidate-chat-sandbox-destroy" },
      )
    })
  }
  const rows = await withOrgDbContext(input.orgId, () =>
    listSandboxInstances({
      conversationId: input.conversationId,
      kind: "chat",
    }),
  )
  for (const row of rows) {
    await deleteSandboxInstance(row.id, input.orgId).catch((error) => {
      getLogger().error(
        error instanceof Error ? error : new Error(String(error)),
        { step: "invalidate-chat-sandbox-row", sandboxId: row.id },
      )
    })
  }
}

export function streamSawOpenCodeSession(chunk: object): boolean {
  const record = chunk as {
    type?: string
    name?: string
    value?: { sessionId?: string; id?: string }
  }
  if (record.type === "CUSTOM" && record.name === "opencode.session-id") {
    return true
  }
  if (typeof record.name === "string" && record.name.includes("session-id")) {
    return true
  }
  return Boolean(record.value?.sessionId || record.value?.id)
}
