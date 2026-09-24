import { join, resolve } from "node:path"
import type { Client, Scope } from "../constants.js"
import type {
  Operation,
  OperationContext,
  WriteJsonOperation,
  WriteTextOperation,
} from "../mcp/mcp-operations.js"
import {
  buildMemorySkillOperations,
  createOperationContext,
} from "../mcp/mcp-operations.js"
import { isObject } from "../mcp/json.js"
import { relativePath, scopesFor } from "../mcp/paths.js"
import { AI_MEMORY_RULE_BODY } from "./seed.js"

const OBSERVE = (host: string, event: string) =>
  `npx -y ctxpipe memory capture observe --host ${host} --event ${event}`
/** Observe then summarize in one process (hosts that run Stop handlers in parallel). */
const FINALIZE = (host: string, event: string) =>
  `npx -y ctxpipe memory capture finalize --host ${host} --event ${event}`

const CURSOR_HOOKS = {
  beforeSubmitPrompt: [{ command: OBSERVE("cursor", "beforeSubmitPrompt") }],
  // afterFileEdit / postToolUse mint tool dumps (MCP schemas, grep, test edits).
  // Cursor capture is prompt + Stop only; those events are stripped on merge.
  stop: [{ command: FINALIZE("cursor", "stop"), loop_limit: 1 }],
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
  // Stop carries last_assistant_message; one sync finalize (observe + summary).
  // PostToolUse classified tool dumps as lessons — same Cursor hole. Prompt + Stop only.
  Stop: [
    {
      hooks: [
        {
          type: "command",
          command: FINALIZE("claude", "Stop"),
        },
      ],
    },
  ],
}

/** VS Code agent hooks (`.github/hooks/*.json`, `~/.copilot/hooks/`); Claude-compatible shape. */
const VSCODE_HOOKS = {
  hooks: {
    UserPromptSubmit: [
      { type: "command", command: OBSERVE("vscode", "UserPromptSubmit") },
    ],
    Stop: [{ type: "command", command: FINALIZE("vscode", "Stop") }],
  },
}

/**
 * OpenCode has no Stop hook: after the turn ends (`session.idle`) the plugin
 * posts the follow-up as a new message, as Cursor does with followup_message.
 * Observe is not awaited so npx start-up never delays a prompt.
 */
export const OPENCODE_PLUGIN = `// ctxpipe local memory capture. Managed by \`npx ctxpipe memory init\`; edits are overwritten.
export const CtxpipeMemory = async ({ client, $, directory }) => {
  const capture = async (command, event, payload) => {
    const input = new Response(JSON.stringify({ cwd: directory, ...payload }))
    const out = await $\`npx -y ctxpipe memory capture \${command} --host opencode --event \${event} < \${input}\`
      .cwd(directory)
      .quiet()
      .nothrow()
      .text()
    try {
      return JSON.parse(out)
    } catch {
      return {}
    }
  }

  return {
    "chat.message": async (input, output) => {
      const prompt = output.parts
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\\n")
      if (!prompt.trim()) return
      capture("observe", "UserPromptSubmit", { prompt, session_id: input.sessionID }).catch(() => {})
    },
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = event.properties?.sessionID
      if (!sessionID) return
      const out = await capture("finalize", "Stop", { session_id: sessionID })
      const text = typeof out.followup_message === "string" ? out.followup_message.trim() : ""
      if (!text) return
      await client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
      })
    },
  }
}
`

const MEMORY_INSTRUCTION_MARKER_START = "<!-- BEGIN ctxpipe-memory-capture -->"
const MEMORY_INSTRUCTION_MARKER_END = "<!-- END ctxpipe-memory-capture -->"

function memoryInstructionBody(host: "opencode" | "vscode" | "codex"): string {
  return `${MEMORY_INSTRUCTION_MARKER_START}
## Local memory (ctxpipe)

Durable facts live in Markdown under \`.ai/memory/\` (see \`index.md\`). Candidates go to
gitignored \`.ai/memory/events/\`; promote with capture skills — never auto-write ADRs
from capture alone.

On hosts without lifecycle hooks, after a meaningful edit or before ending a turn, pipe a
JSON payload that includes \`cwd\` **and** fact-bearing text (\`prompt\`,
\`last_assistant_message\`, and/or \`edits\`). \`cwd\` alone writes nothing:

\`\`\`bash
printf '%s' '{"cwd":".","prompt":"We decided the billing service runs on port 4000"}' \\
  | npx -y ctxpipe memory capture observe --host ${host} --event PostToolUse
printf '%s' '{"cwd":".","last_assistant_message":"Prefer ADRs in .ai/memory/decisions/ as the canonical source of truth."}' \\
  | npx -y ctxpipe memory capture finalize --host ${host} --event Stop
\`\`\`

When candidates surface, write durable Markdown, update the matching \`index.md\`, then:

\`\`\`bash
npx -y ctxpipe memory capture promote <candidateId>
# or: npx -y ctxpipe memory capture dismiss <candidateId>
npx -y ctxpipe memory capture summary
\`\`\`

Commit \`.ai/memory/\` changes with the work they came from, on that work's branch, and
summarize the work in its pull request description (what changed, why, what was ruled out).
If a lesson corrects \`ctx_advisor\` advice, add a \`**Corrects:**\` line saying what it advised.${MEMORY_INSTRUCTION_MARKER_END}
`
}

const CODEX_HOOKS_MARKER_START = "# BEGIN ctxpipe-memory-capture"
const CODEX_HOOKS_MARKER_END = "# END ctxpipe-memory-capture"

function codexHooksToml(): string {
  return `${CODEX_HOOKS_MARKER_START}
[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "${OBSERVE("codex", "UserPromptSubmit")}"

[[hooks.PostToolUse]]
[[hooks.PostToolUse.hooks]]
type = "command"
command = "${OBSERVE("codex", "PostToolUse")}"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "${FINALIZE("codex", "Stop")}"
${CODEX_HOOKS_MARKER_END}
`
}

function commandIsCtxpipeCapture(cmd: unknown): boolean {
  return typeof cmd === "string" && cmd.includes("ctxpipe memory capture")
}

/** Strip our capture hooks from a matcher group; keep sibling handlers. */
function stripCtxpipeFromHookEntry(entry: unknown): unknown | null {
  if (!isObject(entry)) return entry
  const hooks = (entry as { hooks?: unknown }).hooks
  if (Array.isArray(hooks)) {
    const kept = hooks.filter((hook) => {
      if (!isObject(hook)) return true
      return !commandIsCtxpipeCapture((hook as { command?: unknown }).command)
    })
    if (kept.length === 0) return null
    return { ...entry, hooks: kept }
  }
  if (commandIsCtxpipeCapture((entry as { command?: unknown }).command)) {
    return null
  }
  return entry
}

function dedupeHookEntries(existing: unknown[], ours: unknown[]): unknown[] {
  const filtered = existing
    .map((entry) => stripCtxpipeFromHookEntry(entry))
    .filter((entry): entry is NonNullable<typeof entry> => entry != null)
  return [...filtered, ...ours]
}

function mergeCursorHooks(existing: Record<string, unknown>): Record<string, unknown> {
  const hooks = isObject(existing.hooks) ? { ...existing.hooks } : {}
  for (const [key, ours] of Object.entries(CURSOR_HOOKS)) {
    const prev = Array.isArray(hooks[key]) ? (hooks[key] as unknown[]) : []
    hooks[key] = dedupeHookEntries(prev, ours)
  }
  // Drop legacy Cursor observe hooks that classified MCP/grep/test dumps as lessons.
  for (const key of ["afterFileEdit", "postToolUse"]) {
    const prev = Array.isArray(hooks[key]) ? (hooks[key] as unknown[]) : []
    const kept = prev
      .map((entry) => stripCtxpipeFromHookEntry(entry))
      .filter((entry): entry is NonNullable<typeof entry> => entry != null)
    if (kept.length === 0) delete hooks[key]
    else hooks[key] = kept
  }
  return {
    ...existing,
    version: typeof existing.version === "number" ? existing.version : 1,
    hooks,
  }
}

function mergeClaudeHooks(existing: Record<string, unknown>): Record<string, unknown> {
  const existingHooks = isObject(existing.hooks) ? existing.hooks : {}
  const next: Record<string, unknown> = { ...existingHooks }
  for (const [key, ours] of Object.entries(CLAUDE_HOOK_BLOCK)) {
    const prev = Array.isArray((existingHooks as Record<string, unknown>)[key])
      ? ((existingHooks as Record<string, unknown[]>)[key] as unknown[])
      : []
    next[key] = dedupeHookEntries(prev, ours)
  }
  // Drop leftover Claude observe hooks that classified tool dumps as lessons.
  for (const key of ["PostToolUse"]) {
    const prev = Array.isArray(next[key]) ? (next[key] as unknown[]) : []
    const kept = prev
      .map((entry) => stripCtxpipeFromHookEntry(entry))
      .filter((entry): entry is NonNullable<typeof entry> => entry != null)
    if (kept.length === 0) delete next[key]
    else next[key] = kept
  }
  return {
    ...existing,
    hooks: next,
  }
}

function upsertMarkedText(
  existing: string | null | undefined,
  block: string,
  start: string,
  end: string,
): string {
  const prev = existing ?? ""
  const startIdx = prev.indexOf(start)
  const endIdx = prev.indexOf(end)
  if (startIdx >= 0 && endIdx > startIdx) {
    const before = prev.slice(0, startIdx).trimEnd()
    const after = prev.slice(endIdx + end.length).trimStart()
    return [before, block.trim(), after].filter(Boolean).join("\n\n") + "\n"
  }
  if (!prev.trim()) return `${block.trim()}\n`
  return `${prev.trimEnd()}\n\n${block.trim()}\n`
}

function upsertInstructionMarkdown(
  existing: string | null | undefined,
  host: "opencode" | "vscode" | "codex",
): string {
  return upsertMarkedText(
    existing,
    memoryInstructionBody(host),
    MEMORY_INSTRUCTION_MARKER_START,
    MEMORY_INSTRUCTION_MARKER_END,
  )
}

/** Modular Copilot `*.instructions.md` with applyTo so the host auto-attaches. */
function upsertCopilotInstructionsMd(existing: string | null | undefined): string {
  const body = upsertInstructionMarkdown(existing, "vscode")
  // Idempotent: generated header is `---\napplyTo: ...` (no blank line after ---).
  if (/^---\r?\napplyTo:/m.test(body) || /^applyTo:/m.test(body)) return body
  return `---\napplyTo: "**"\ndescription: "ctxpipe local Markdown memory capture"\n---\n\n${body}`
}

function upsertCodexConfigToml(existing: string | null | undefined): string {
  return upsertMarkedText(
    existing,
    codexHooksToml(),
    CODEX_HOOKS_MARKER_START,
    CODEX_HOOKS_MARKER_END,
  )
}

function mergeOpenCodeInstructions(
  existing: Record<string, unknown>,
  instructionPath: string,
): Record<string, unknown> {
  const prev = Array.isArray(existing.instructions)
    ? (existing.instructions as unknown[]).filter(
        (x): x is string => typeof x === "string",
      )
    : []
  const next = prev.includes(instructionPath)
    ? prev
    : [...prev, instructionPath]
  return {
    ...existing,
    $schema:
      typeof existing.$schema === "string"
        ? existing.$schema
        : "https://opencode.ai/config.json",
    instructions: next,
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
  path,
  context = createOperationContext(),
}: {
  path: string
  context?: OperationContext
}): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `install Claude Code capture hooks at ${relativePath(path, context.cwd)}`,
    content(existing = {}) {
      return mergeClaudeHooks(existing)
    },
  }
}

function buildCodexHooksOperation({
  path,
  context,
}: {
  path: string
  context: OperationContext
}): WriteTextOperation {
  return {
    type: "write-text",
    path,
    description: `install Codex memory capture hooks at ${relativePath(path, context.cwd)}`,
    content(existing) {
      return upsertCodexConfigToml(existing)
    },
  }
}

function buildVscodeHooksOperation({
  path,
  context,
}: {
  path: string
  context: OperationContext
}): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `install VS Code memory capture hooks at ${relativePath(path, context.cwd)}`,
    content: () => VSCODE_HOOKS,
  }
}

function buildOpenCodePluginOperation({
  path,
  context,
}: {
  path: string
  context: OperationContext
}): WriteTextOperation {
  return {
    type: "write-text",
    path,
    description: `install OpenCode memory capture plugin at ${relativePath(path, context.cwd)}`,
    content: () => OPENCODE_PLUGIN,
  }
}

function buildInstructionFileOperation({
  path,
  context,
  label,
  host,
  copilotInstructionsMd = false,
}: {
  path: string
  context: OperationContext
  label: string
  host: "opencode" | "vscode" | "codex"
  /** When true, wrap with applyTo frontmatter for auto-attach. */
  copilotInstructionsMd?: boolean
}): WriteTextOperation {
  return {
    type: "write-text",
    path,
    description: `install ${label} memory capture instructions at ${relativePath(path, context.cwd)}`,
    content(existing) {
      return copilotInstructionsMd
        ? upsertCopilotInstructionsMd(existing)
        : upsertInstructionMarkdown(existing, host)
    },
  }
}

function buildOpenCodeConfigOperation({
  path,
  context,
  instructionPath,
}: {
  path: string
  context: OperationContext
  instructionPath: string
}): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `wire OpenCode instructions for memory capture at ${relativePath(path, context.cwd)}`,
    content(existing = {}) {
      return mergeOpenCodeInstructions(existing, instructionPath)
    },
  }
}

/** Install host hooks / instruction artifacts for selected agents. */
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
    for (const s of scopes) {
      const claudeRoot =
        s === "repo"
          ? resolve(context.cwd, ".claude")
          : join(context.homeDir, ".claude")
      const rulePath = join(claudeRoot, "rules", "ai-memory.md")
      ops.push(
        buildClaudeCaptureHooksOperation({
          path: join(claudeRoot, "settings.json"),
          context,
        }),
        // Claude Code loads .claude/rules every session, whether it reads
        // CLAUDE.md or falls back to AGENTS.md; never create CLAUDE.md, which
        // would switch that fallback off.
        {
          type: "write-text",
          path: rulePath,
          description: `install Claude Code memory rule at ${relativePath(rulePath, context.cwd)}`,
          content: () => AI_MEMORY_RULE_BODY,
        },
        ...buildMemorySkillOperations(join(claudeRoot, "skills"), context),
      )
    }
  }

  if (clients.includes("codex")) {
    for (const s of scopes) {
      if (s === "repo") {
        ops.push(
          buildCodexHooksOperation({
            path: resolve(context.cwd, ".codex", "config.toml"),
            context,
          }),
        )
        ops.push(
          buildInstructionFileOperation({
            path: resolve(context.cwd, "AGENTS.md"),
            context,
            label: "Codex",
            host: "codex",
          }),
        )
      } else if (s === "user") {
        ops.push(
          buildCodexHooksOperation({
            path: join(context.homeDir, ".codex", "config.toml"),
            context,
          }),
        )
        ops.push(
          buildInstructionFileOperation({
            path: join(context.homeDir, ".codex", "AGENTS.md"),
            context,
            label: "Codex user",
            host: "codex",
          }),
        )
      }
    }
  }

  if (clients.includes("opencode")) {
    for (const s of scopes) {
      if (s === "repo") {
        const instructionRel = ".opencode/memory-capture.md"
        ops.push(
          buildInstructionFileOperation({
            path: resolve(context.cwd, instructionRel),
            context,
            label: "OpenCode",
            host: "opencode",
          }),
        )
        ops.push(
          buildOpenCodeConfigOperation({
            path: resolve(context.cwd, "opencode.json"),
            context,
            instructionPath: instructionRel,
          }),
        )
        ops.push(
          buildInstructionFileOperation({
            path: resolve(context.cwd, "AGENTS.md"),
            context,
            label: "OpenCode AGENTS",
            host: "opencode",
          }),
        )
        ops.push(
          buildOpenCodePluginOperation({
            path: resolve(context.cwd, ".opencode", "plugins", "ctxpipe-memory.js"),
            context,
          }),
        )
      } else if (s === "user") {
        const instructionRel = "memory-capture.md"
        ops.push(
          buildInstructionFileOperation({
            path: join(
              context.homeDir,
              ".config",
              "opencode",
              instructionRel,
            ),
            context,
            label: "OpenCode user",
            host: "opencode",
          }),
        )
        ops.push(
          buildInstructionFileOperation({
            path: join(context.homeDir, ".config", "opencode", "AGENTS.md"),
            context,
            label: "OpenCode user AGENTS",
            host: "opencode",
          }),
        )
        ops.push(
          buildOpenCodeConfigOperation({
            path: join(context.homeDir, ".config", "opencode", "opencode.json"),
            context,
            instructionPath: instructionRel,
          }),
        )
        ops.push(
          buildOpenCodePluginOperation({
            path: join(
              context.homeDir,
              ".config",
              "opencode",
              "plugins",
              "ctxpipe-memory.js",
            ),
            context,
          }),
        )
      }
    }
  }

  if (clients.includes("vscode")) {
    for (const s of scopes) {
      if (s === "repo") {
        ops.push(
          buildInstructionFileOperation({
            path: resolve(context.cwd, ".github", "copilot-instructions.md"),
            context,
            label: "VS Code Copilot",
            host: "vscode",
          }),
        )
        ops.push(
          buildInstructionFileOperation({
            path: resolve(
              context.cwd,
              ".github",
              "instructions",
              "ctxpipe-memory.instructions.md",
            ),
            context,
            label: "VS Code modular",
            host: "vscode",
            copilotInstructionsMd: true,
          }),
        )
        ops.push(
          buildVscodeHooksOperation({
            path: resolve(context.cwd, ".github", "hooks", "ctxpipe-memory.json"),
            context,
          }),
        )
      } else if (s === "user") {
        ops.push(
          buildInstructionFileOperation({
            path: join(context.homeDir, ".copilot", "copilot-instructions.md"),
            context,
            label: "VS Code Copilot user",
            host: "vscode",
          }),
        )
        ops.push(
          buildInstructionFileOperation({
            path: join(
              context.homeDir,
              ".copilot",
              "instructions",
              "ctxpipe-memory.instructions.md",
            ),
            context,
            label: "VS Code Copilot user modular",
            host: "vscode",
            copilotInstructionsMd: true,
          }),
        )
        ops.push(
          buildVscodeHooksOperation({
            path: join(context.homeDir, ".copilot", "hooks", "ctxpipe-memory.json"),
            context,
          }),
        )
      }
    }
  }

  return ops
}
