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
  if (input.plannedFileCount > 0) return { action: "write_planned" }
  if (LLM_WRITE_KINDS.has(input.kind)) return { action: "run_agent" }
  return { action: "skip" }
}

export function writeJobAgentPrompt(input: {
  kind: WorkspaceWriteKind
  worktreePath: string
}): string {
  return [
    `Write markdown for the ${input.kind} job.`,
    `Worktree: ${input.worktreePath}`,
    "Return only files to write. Do not commit or push.",
  ].join("\n")
}

export async function runWriteJobAgent(input: {
  kind: WorkspaceWriteKind
  worktreePath: string
  fs: JobWorktreeFs
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
      plan.action === "run_agent" && generate
        ? (worktreePath) =>
            runWriteJobAgent({
              kind: input.kind,
              worktreePath,
              fs: sandbox.fs,
              generate,
            })
        : undefined,
  })
  return { ...collected, via: "worktree" }
}
