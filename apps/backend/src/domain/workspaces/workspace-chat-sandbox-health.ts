import { withOrgDbContext } from "../../db/client.js"
import {
  deleteSandboxInstance,
  listSandboxInstances,
} from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import type { TanstackLikeHandle } from "./job-sandbox.js"
import { clearWorkspaceChatOpenCodeSessionId } from "./workspace-chat-opencode-session.js"

type ExecResult = { stdout: string; stderr: string; exitCode: number }

async function sandboxExec(
  handle: TanstackLikeHandle,
  command: string,
): Promise<ExecResult> {
  const exec = handle.process?.exec
  if (!exec) {
    throw new Error("Chat sandbox handle cannot exec")
  }
  return exec(command)
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
