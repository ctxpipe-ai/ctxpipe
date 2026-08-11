import { join, resolve } from "node:path"
import type { Client, Scope } from "../constants.js"
import type { Operation, OperationContext, WriteJsonOperation } from "../mcp/mcp-operations.js"
import { createOperationContext } from "../mcp/mcp-operations.js"
import { isObject } from "../mcp/json.js"
import { relativePath, scopesFor } from "../mcp/paths.js"

const OBSERVE = (host: string, event: string) =>
  `npx -y ctxpipe memory capture observe --host ${host} --event ${event}`
const SUMMARY = `npx -y ctxpipe memory capture summary`

const CURSOR_HOOKS = {
  beforeSubmitPrompt: [{ command: OBSERVE("cursor", "beforeSubmitPrompt") }],
  afterFileEdit: [{ command: OBSERVE("cursor", "afterFileEdit") }],
  postToolUse: [{ command: OBSERVE("cursor", "postToolUse") }],
  stop: [{ command: SUMMARY }],
}

const CLAUDE_HOOK_BLOCK = {
  UserPromptSubmit: [
    {
      hooks: [
        {
          type: "command",
          command: OBSERVE("claude", "UserPromptSubmit"),
        },
      ],
    },
  ],
  PostToolUse: [
    {
      hooks: [
        {
          type: "command",
          command: OBSERVE("claude", "PostToolUse"),
        },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        {
          type: "command",
          command: SUMMARY,
          async: true,
        },
      ],
    },
  ],
}

function dedupeHookEntries(existing: unknown[], ours: unknown[]): unknown[] {
  const filtered = existing.filter((entry) => !entryMentionsCtxpipeCapture(entry))
  return [...filtered, ...ours]
}

function entryMentionsCtxpipeCapture(entry: unknown): boolean {
  if (!isObject(entry)) return false
  const hooks = (entry as { hooks?: unknown }).hooks
  if (Array.isArray(hooks)) {
    return hooks.some((hook) => {
      if (!isObject(hook)) return false
      const cmd = (hook as { command?: unknown }).command
      return typeof cmd === "string" && cmd.includes("ctxpipe memory capture")
    })
  }
  const cmd = (entry as { command?: unknown }).command
  return typeof cmd === "string" && cmd.includes("ctxpipe memory capture")
}

function mergeCursorHooks(existing: Record<string, unknown>): Record<string, unknown> {
  const hooks = isObject(existing.hooks) ? { ...existing.hooks } : {}
  for (const [key, ours] of Object.entries(CURSOR_HOOKS)) {
    const prev = Array.isArray(hooks[key]) ? (hooks[key] as unknown[]) : []
    hooks[key] = dedupeHookEntries(prev, ours)
  }
  return {
    ...existing,
    version: typeof existing.version === "number" ? existing.version : 1,
    hooks,
  }
}

export function buildCursorHooksOperation({
  path,
  context,
}: {
  path: string
  context: OperationContext
}): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `install Cursor memory capture hooks at ${relativePath(path, context.cwd)}`,
    content(existing = {}) {
      return mergeCursorHooks(existing)
    },
  }
}

export function buildClaudeCaptureHooksOperation({
  context = createOperationContext(),
}: {
  context?: OperationContext
} = {}): WriteJsonOperation {
  const path = join(context.homeDir, ".claude", "settings.local.json")
  return {
    type: "write-json",
    path,
    description:
      "install Claude Code capture hooks in ~/.claude/settings.local.json",
    content(existing = {}) {
      const existingHooks = isObject(existing.hooks) ? existing.hooks : {}
      const next: Record<string, unknown> = { ...existingHooks }
      for (const [key, ours] of Object.entries(CLAUDE_HOOK_BLOCK)) {
        const prev = Array.isArray(
          (existingHooks as Record<string, unknown>)[key],
        )
          ? ((existingHooks as Record<string, unknown[]>)[key] as unknown[])
          : []
        next[key] = dedupeHookEntries(prev, ours)
      }
      return {
        ...existing,
        hooks: next,
      }
    },
  }
}

/** Install host hooks for selected agents. Claude hooks are user-scoped; Cursor is repo/user by scope. */
export function buildMemoryHookOperations({
  clients,
  scope,
  context = createOperationContext(),
}: {
  clients: Client[]
  scope: Scope
  context?: OperationContext
}): Operation[] {
  const ops: Operation[] = []
  const scopes = scopesFor(scope)

  if (clients.includes("cursor")) {
    for (const s of scopes) {
      if (s === "repo") {
        ops.push(
          buildCursorHooksOperation({
            path: resolve(context.cwd, ".cursor", "hooks.json"),
            context,
          }),
        )
      } else if (s === "user") {
        ops.push(
          buildCursorHooksOperation({
            path: join(context.homeDir, ".cursor", "hooks.json"),
            context,
          }),
        )
      }
    }
  }

  if (clients.includes("claude")) {
    // Claude Code hooks live in user settings; install whenever Claude is selected.
    ops.push(buildClaudeCaptureHooksOperation({ context }))
  }

  for (const client of clients) {
    if (client === "cursor" || client === "claude") continue
    ops.push({
      type: "manual",
      description: `memory capture hooks for ${client}`,
      detail: `${client} has no first-class project hook install yet. Rely on .cursor/rules/ai-memory.mdc (or equivalent agent instructions) and run \`npx ctxpipe memory capture summary\` at session end when useful.`,
    })
  }

  return ops
}
