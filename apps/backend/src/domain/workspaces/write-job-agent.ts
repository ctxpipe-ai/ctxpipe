import {
  type JobSandboxHandle,
  type JobWorktreeFs,
  joinWorktreePath,
  runJobWorktree,
} from "./job-worktree.js"
import type { WorkspaceWriteKind } from "./write-commit-files.js"
import { jobUsesInSandboxWorktree } from "./write-runner.js"

const LLM_WRITE_KINDS = new Set<WorkspaceWriteKind>([
  "extract_ingest",
  "semantic_merge",
])

export function planWriteJobAgent(input: {
  kind: WorkspaceWriteKind
  plannedFileCount: number
  hasJobSandbox: boolean
}):
  | { action: "github_api" }
  | { action: "write_planned" }
  | { action: "run_agent" }
  | { action: "skip" } {
  if (!input.hasJobSandbox || !jobUsesInSandboxWorktree(input.kind)) {
    return { action: "github_api" }
  }
  if (input.kind === "semantic_merge") return { action: "run_agent" }
  if (input.plannedFileCount > 0) return { action: "write_planned" }
  if (LLM_WRITE_KINDS.has(input.kind)) return { action: "run_agent" }
  return { action: "skip" }
}

export function parseWriteJobAgentFiles(
  raw: string,
): Array<{ path: string; content: string }> {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = fenced?.[1]?.trim() ?? trimmed
  try {
    const parsed = JSON.parse(jsonText) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const row = item as { path?: unknown; content?: unknown }
      if (typeof row.path !== "string" || typeof row.content !== "string") {
        return []
      }
      return [{ path: row.path, content: row.content }]
    })
  } catch {
    return []
  }
}

export async function invokeWriteJobModel(prompt: string): Promise<string> {
  const { getModel } = await import("../../retrieval/services/modelProvider.js")
  const model = getModel("fast")
  const result = await model.invoke(prompt)
  const content = result.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part && "text" in part
          ? String(part.text)
          : "",
      )
      .join("")
  }
  return String(content ?? "")
}

export async function generateWriteJobFiles(input: {
  kind: WorkspaceWriteKind
  worktreePath: string
  conflictParentSha?: string | null
  remoteTipSha?: string | null
  generate?: (prompt: string) => Promise<string>
}): Promise<Array<{ path: string; content: string }>> {
  const generate = input.generate ?? invokeWriteJobModel
  try {
    return parseWriteJobAgentFiles(
      await generate(
        writeJobAgentPrompt({
          kind: input.kind,
          worktreePath: input.worktreePath,
          conflictParentSha: input.conflictParentSha,
          remoteTipSha: input.remoteTipSha,
        }),
      ),
    )
  } catch {
    return []
  }
}

export function writeJobAgentPrompt(input: {
  kind: WorkspaceWriteKind
  worktreePath: string
  conflictParentSha?: string | null
  remoteTipSha?: string | null
}): string {
  const lines = [
    `Write markdown for the ${input.kind} job.`,
    `Worktree: ${input.worktreePath}`,
    "Return only files to write. Do not commit or push.",
  ]
  if (input.kind === "semantic_merge") {
    lines.push(
      `Conflicting commit (ours / captured parent): ${input.conflictParentSha ?? "unknown"}`,
      `New remote tip: ${input.remoteTipSha ?? "unknown"}`,
      "The worktree is checked out at the new remote tip with the captured job files already written.",
      "Merge both sides' knowledge in those files. Keep both facts; do not force-push.",
      "Return JSON files to write after the merge.",
    )
  }
  return lines.join("\n")
}

export async function runWriteJobAgent(input: {
  kind: WorkspaceWriteKind
  worktreePath: string
  fs: JobWorktreeFs
  conflictParentSha?: string | null
  remoteTipSha?: string | null
  generate: (
    prompt: string,
  ) => Promise<Array<{ path: string; content: string }>>
  withSandbox?: (...args: unknown[]) => unknown
}): Promise<void> {
  void input.withSandbox
  const files = await input.generate(
    writeJobAgentPrompt({
      kind: input.kind,
      worktreePath: input.worktreePath,
      conflictParentSha: input.conflictParentSha,
      remoteTipSha: input.remoteTipSha,
    }),
  )
  for (const file of files) {
    const dest = joinWorktreePath(input.worktreePath, file.path)
    if (!dest) continue
    const parent = dest.split("/").slice(0, -1).join("/")
    if (parent) await input.fs.mkdir(parent)
    await input.fs.write(dest, file.content)
  }
}

export async function applyJobWorktreeIfPresent(input: {
  worktree: { spawn: true; worktree: string } | { spawn: false; reason: string }
  kind: WorkspaceWriteKind
  files: Array<{ path: string; content: string }>
  deletePaths: string[]
  sandbox: JobSandboxHandle | null
  conflictParentSha?: string | null
  remoteTipSha?: string | null
  generate?: (
    prompt: string,
  ) => Promise<Array<{ path: string; content: string }>>
}): Promise<{
  files: Array<{ path: string; content: string }>
  deletePaths: string[]
  via: "worktree" | "github_api"
}> {
  const sandbox = input.sandbox
  const generate = input.generate
  if (!input.worktree.spawn || !sandbox) {
    return {
      files: input.files,
      deletePaths: input.deletePaths,
      via: "github_api",
    }
  }
  const plan = planWriteJobAgent({
    kind: input.kind,
    plannedFileCount: input.files.length,
    hasJobSandbox: true,
  })
  const collected = await runJobWorktree({
    worktree: input.worktree.worktree,
    files: input.files,
    deletePaths: input.deletePaths,
    exec: sandbox.exec,
    fs: sandbox.fs,
    agent:
      plan.action === "run_agent"
        ? (worktreePath) =>
            runWriteJobAgent({
              kind: input.kind,
              worktreePath,
              fs: sandbox.fs,
              conflictParentSha: input.conflictParentSha,
              remoteTipSha: input.remoteTipSha,
              generate:
                generate ??
                (async (prompt) =>
                  parseWriteJobAgentFiles(await invokeWriteJobModel(prompt))),
            })
        : undefined,
  })
  return { ...collected, via: "worktree" }
}
