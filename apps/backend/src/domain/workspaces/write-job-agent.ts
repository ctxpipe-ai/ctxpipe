import { looksLikeGitSha } from "./hydrate-phases.js"
import {
  type JobSandboxHandle,
  type JobWorktreeExec,
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

export const SEMANTIC_MERGE_MAX_TURNS = 8

const SEMANTIC_MERGE_TOOLS = new Set(["git_diff", "read_file", "git_show"])

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
  return parseWriteJobAgentResult(raw).files
}

export function parseWriteJobAgentResult(raw: string): {
  files: Array<{ path: string; content: string }>
  deletePaths: string[]
} {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = fenced?.[1]?.trim() ?? trimmed
  try {
    const parsed = JSON.parse(jsonText) as unknown
    if (Array.isArray(parsed)) {
      return { files: filesFromUnknown(parsed), deletePaths: [] }
    }
    if (!parsed || typeof parsed !== "object") {
      return { files: [], deletePaths: [] }
    }
    const row = parsed as { files?: unknown; deletePaths?: unknown }
    return {
      files: filesFromUnknown(row.files),
      deletePaths: pathsFromUnknown(row.deletePaths),
    }
  } catch {
    return { files: [], deletePaths: [] }
  }
}

function filesFromUnknown(
  raw: unknown,
): Array<{ path: string; content: string }> {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const row = item as { path?: unknown; content?: unknown }
    if (typeof row.path !== "string" || typeof row.content !== "string") {
      return []
    }
    return [{ path: row.path, content: row.content }]
  })
}

function pathsFromUnknown(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => (typeof item === "string" && item ? [item] : []))
}

export function parseSemanticMergeJson(raw: string): {
  files: Array<{ path: string; content: string }>
  deletePaths: string[]
} | null {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = fenced?.[1]?.trim() ?? trimmed
  try {
    const parsed = JSON.parse(jsonText) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    const row = parsed as { files?: unknown; deletePaths?: unknown }
    if (!Array.isArray(row.files) || !Array.isArray(row.deletePaths)) {
      return null
    }
    return {
      files: filesFromUnknown(row.files),
      deletePaths: pathsFromUnknown(row.deletePaths),
    }
  } catch {
    return null
  }
}

export function semanticMergeTreeShas(input: {
  conflictParentSha?: string | null
  remoteTipSha?: string | null
}): { conflictParentSha: string; remoteTipSha: string } {
  const conflictParentSha = input.conflictParentSha?.trim() ?? ""
  const remoteTipSha = input.remoteTipSha?.trim() ?? ""
  if (
    !looksLikeGitSha(conflictParentSha) ||
    !looksLikeGitSha(remoteTipSha) ||
    conflictParentSha === remoteTipSha
  ) {
    throw new Error("semantic merge requires both trees in the job worktree")
  }
  return { conflictParentSha, remoteTipSha }
}

export function semanticMergeGitDiffCommand(
  conflictParentSha: string,
  remoteTipSha: string,
): string | null {
  if (!looksLikeGitSha(conflictParentSha) || !looksLikeGitSha(remoteTipSha)) {
    return null
  }
  return `git diff ${conflictParentSha} ${remoteTipSha}`
}

export function parseSemanticMergeTurn(raw: string): Array<{
  name: "git_diff" | "read_file" | "git_show"
  args: Record<string, string>
}> {
  const calls: Array<{
    name: "git_diff" | "read_file" | "git_show"
    args: Record<string, string>
  }> = []
  for (const line of raw.split("\n")) {
    const match = line
      .trim()
      .match(/^TOOL\s+(git_diff|read_file|git_show)(?:\s+(.*))?$/i)
    if (!match) continue
    const name = match[1]?.toLowerCase()
    if (name !== "git_diff" && name !== "read_file" && name !== "git_show") {
      continue
    }
    calls.push({ name, args: parseToolArgs(match[2] ?? "") })
  }
  return calls
}

function parseToolArgs(raw: string): Record<string, string> {
  const args: Record<string, string> = {}
  for (const part of raw.trim().split(/\s+/)) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    args[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return args
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
  mergeFiles?: ReadonlyArray<{ path: string; content: string }>
  mergeDeletePaths?: readonly string[]
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
      "The worktree is checked out at the new remote tip. Diff both trees with git_diff.",
      "read_file is the remote tip. git_show reads a commit. Keep both sides' knowledge.",
      "The failed job candidate is listed below and is NOT checked out. Deletions are allowed. Do not force-push.",
      'Each turn emit TOOL lines, or finish with JSON {"files":[...],"deletePaths":[...]}.',
      "TOOL git_diff",
      "TOOL read_file path=knowledge/example.md",
      "TOOL git_show sha=<parent-or-tip> path=knowledge/example.md",
    )
    if (input.mergeFiles?.length) {
      lines.push("# failed job candidate (not checked out)")
      for (const file of input.mergeFiles) {
        lines.push(`FILE ${file.path}\n${file.content}`)
      }
    }
    if (input.mergeDeletePaths?.length) {
      lines.push(`# failed job deletes\n${input.mergeDeletePaths.join("\n")}`)
    }
  }
  return lines.join("\n")
}

export async function executeSemanticMergeTool(input: {
  name: string
  args: Record<string, string>
  worktreePath: string
  conflictParentSha: string
  remoteTipSha: string
  exec: JobWorktreeExec
  fs: JobWorktreeFs
}): Promise<string> {
  if (!SEMANTIC_MERGE_TOOLS.has(input.name)) {
    throw new Error("unknown tool")
  }
  if (input.name === "git_diff") {
    const command = semanticMergeGitDiffCommand(
      input.conflictParentSha,
      input.remoteTipSha,
    )
    if (!command) throw new Error("invalid sha")
    const result = await input.exec(command, {
      cwd: input.worktreePath,
      env: {},
    })
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "git diff failed")
    }
    return result.stdout || "(empty diff)"
  }
  if (input.name === "read_file") {
    const relative = input.args.path ?? ""
    if (!/^[A-Za-z0-9._\-/]+$/.test(relative)) {
      throw new Error("invalid path")
    }
    const dest = joinWorktreePath(input.worktreePath, relative)
    if (!dest) throw new Error("invalid path")
    try {
      return await input.fs.read(dest)
    } catch {
      return "missing file"
    }
  }
  const command = gitShowCommand(input.args.sha ?? "", input.args.path ?? "")
  if (!command) throw new Error("invalid git_show")
  const result = await input.exec(command, {
    cwd: input.worktreePath,
    env: {},
  })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "git show failed")
  }
  return result.stdout || "(empty)"
}

export function gitShowCommand(sha: string, path: string): string | null {
  if (!looksLikeGitSha(sha)) return null
  if (!joinWorktreePath("wt", path)) return null
  if (!/^[A-Za-z0-9._\-/]+$/.test(path)) return null
  return `git show ${sha}:${path}`
}

export async function missingSemanticMergeShas(input: {
  exec: JobWorktreeExec
  shas: readonly string[]
  cwd?: string
}): Promise<string[]> {
  const missing: string[] = []
  for (const sha of input.shas) {
    if (!looksLikeGitSha(sha)) {
      missing.push(sha)
      continue
    }
    const probe = await input.exec(`git cat-file -t ${sha}`, {
      cwd: input.cwd ?? ".",
      env: {},
    })
    if (probe.exitCode !== 0 || probe.stdout.trim() !== "commit") {
      missing.push(sha)
    }
  }
  return missing
}

async function ensureSemanticMergeShas(input: {
  worktreePath: string
  conflictParentSha: string
  remoteTipSha: string
  exec: JobWorktreeExec
}): Promise<void> {
  for (const sha of [input.conflictParentSha, input.remoteTipSha]) {
    if (!looksLikeGitSha(sha)) throw new Error("invalid sha")
    const missing = await missingSemanticMergeShas({
      exec: input.exec,
      shas: [sha],
      cwd: input.worktreePath,
    })
    if (missing.length === 0) continue
    const fetched = await input.exec(`git fetch --depth=1 origin ${sha}`, {
      cwd: input.worktreePath,
      env: {},
    })
    if (fetched.exitCode !== 0) {
      throw new Error(fetched.stderr || `missing commit ${sha}`)
    }
  }
}

export async function runSemanticMergeToolLoop(input: {
  worktreePath: string
  conflictParentSha: string
  remoteTipSha: string
  exec: JobWorktreeExec
  fs: JobWorktreeFs
  turn: (prompt: string) => Promise<string>
  mergeFiles?: ReadonlyArray<{ path: string; content: string }>
  mergeDeletePaths?: readonly string[]
  maxTurns?: number
}): Promise<{
  files: Array<{ path: string; content: string }>
  deletePaths: string[]
}> {
  await ensureSemanticMergeShas({
    worktreePath: input.worktreePath,
    conflictParentSha: input.conflictParentSha,
    remoteTipSha: input.remoteTipSha,
    exec: input.exec,
  })
  const initialDiff = await executeSemanticMergeTool({
    name: "git_diff",
    args: {},
    worktreePath: input.worktreePath,
    conflictParentSha: input.conflictParentSha,
    remoteTipSha: input.remoteTipSha,
    exec: input.exec,
    fs: input.fs,
  })
  let prompt = `${writeJobAgentPrompt({
    kind: "semantic_merge",
    worktreePath: input.worktreePath,
    conflictParentSha: input.conflictParentSha,
    remoteTipSha: input.remoteTipSha,
    mergeFiles: input.mergeFiles,
    mergeDeletePaths: input.mergeDeletePaths,
  })}\n\n# git_diff both trees\n${initialDiff}`
  const maxTurns = input.maxTurns ?? SEMANTIC_MERGE_MAX_TURNS
  let last = ""
  for (let turn = 0; turn < maxTurns; turn++) {
    last = await input.turn(prompt)
    const calls = parseSemanticMergeTurn(last)
    if (calls.length === 0) {
      const parsed = parseSemanticMergeJson(last)
      if (!parsed) {
        throw new Error("semantic merge did not return JSON")
      }
      return parsed
    }
    const observations: string[] = []
    for (const call of calls) {
      observations.push(
        await executeSemanticMergeTool({
          name: call.name,
          args: call.args,
          worktreePath: input.worktreePath,
          conflictParentSha: input.conflictParentSha,
          remoteTipSha: input.remoteTipSha,
          exec: input.exec,
          fs: input.fs,
        }),
      )
    }
    prompt = `${prompt}\n\n# turn ${turn + 1}\n${last}\n\n# tool results\n${observations.join("\n---\n")}\nFinish with JSON or emit more TOOL lines.`
  }
  throw new Error("semantic merge tool loop exhausted")
}

export async function runWriteJobAgent(input: {
  kind: WorkspaceWriteKind
  worktreePath: string
  fs: JobWorktreeFs
  exec?: JobWorktreeExec
  conflictParentSha?: string | null
  remoteTipSha?: string | null
  generate?: (
    prompt: string,
  ) => Promise<Array<{ path: string; content: string }>>
  turn?: (prompt: string) => Promise<string>
  mergeFiles?: ReadonlyArray<{ path: string; content: string }>
  mergeDeletePaths?: readonly string[]
  withSandbox?: (...args: unknown[]) => unknown
}): Promise<void> {
  void input.withSandbox
  let files: Array<{ path: string; content: string }> = []
  let deletePaths: string[] = []
  if (input.kind === "semantic_merge") {
    if (!input.exec || !input.conflictParentSha || !input.remoteTipSha) {
      throw new Error("semantic merge requires both trees in the job worktree")
    }
    const merged = await runSemanticMergeToolLoop({
      worktreePath: input.worktreePath,
      conflictParentSha: input.conflictParentSha,
      remoteTipSha: input.remoteTipSha,
      exec: input.exec,
      fs: input.fs,
      turn: input.turn ?? invokeWriteJobModel,
      mergeFiles: input.mergeFiles,
      mergeDeletePaths: input.mergeDeletePaths,
    })
    files = merged.files
    deletePaths = merged.deletePaths
  } else {
    const generate =
      input.generate ??
      (async (prompt) =>
        parseWriteJobAgentFiles(await invokeWriteJobModel(prompt)))
    files = await generate(
      writeJobAgentPrompt({
        kind: input.kind,
        worktreePath: input.worktreePath,
        conflictParentSha: input.conflictParentSha,
        remoteTipSha: input.remoteTipSha,
      }),
    )
  }
  for (const file of files) {
    const dest = joinWorktreePath(input.worktreePath, file.path)
    if (!dest) continue
    const parent = dest.split("/").slice(0, -1).join("/")
    if (parent) await input.fs.mkdir(parent)
    await input.fs.write(dest, file.content)
  }
  for (const path of deletePaths) {
    const dest = joinWorktreePath(input.worktreePath, path)
    if (!dest) continue
    await input.fs.remove(dest)
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
  turn?: (prompt: string) => Promise<string>
}): Promise<{
  files: Array<{ path: string; content: string }>
  deletePaths: string[]
  via: "worktree" | "github_api"
}> {
  const sandbox = input.sandbox
  const generate = input.generate
  if (!input.worktree.spawn || !sandbox) {
    if (input.kind === "semantic_merge") {
      throw new Error("semantic merge requires both trees in the job worktree")
    }
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
  if (input.kind === "semantic_merge") {
    if (!input.conflictParentSha || !input.remoteTipSha) {
      throw new Error("semantic merge requires both trees in the job worktree")
    }
    await ensureSemanticMergeShas({
      worktreePath: ".",
      conflictParentSha: input.conflictParentSha,
      remoteTipSha: input.remoteTipSha,
      exec: sandbox.exec,
    })
  }
  const semanticMerge = input.kind === "semantic_merge"
  const collected = await runJobWorktree({
    worktree: input.worktree.worktree,
    startRef: semanticMerge ? (input.remoteTipSha ?? "HEAD") : "HEAD",
    files: semanticMerge ? [] : input.files,
    deletePaths: semanticMerge ? [] : input.deletePaths,
    exec: sandbox.exec,
    fs: sandbox.fs,
    agent:
      plan.action === "run_agent"
        ? (worktreePath) =>
            runWriteJobAgent({
              kind: input.kind,
              worktreePath,
              fs: sandbox.fs,
              exec: sandbox.exec,
              conflictParentSha: input.conflictParentSha,
              remoteTipSha: input.remoteTipSha,
              generate,
              turn: input.turn,
              mergeFiles: semanticMerge ? input.files : undefined,
              mergeDeletePaths: semanticMerge ? input.deletePaths : undefined,
            })
        : undefined,
  })
  return { ...collected, via: "worktree" }
}
