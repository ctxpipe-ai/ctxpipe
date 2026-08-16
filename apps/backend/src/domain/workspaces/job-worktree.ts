export const WRITE_CREDENTIAL_ENV_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_ID",
  "INSTALLATION_TOKEN",
  "GIT_ASKPASS",
] as const

export type JobWorktreeExec = (
  command: string,
  options?: { cwd?: string; env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>

export type JobWorktreeFs = {
  write: (path: string, data: string) => Promise<void>
  read: (path: string) => Promise<string>
  remove: (path: string) => Promise<void>
  mkdir: (path: string) => Promise<void>
}

export type JobSandboxHandle = {
  exec: JobWorktreeExec
  fs: JobWorktreeFs
}

export function sandboxEnvHasWriteCredentials(
  env: Record<string, string> | undefined,
): boolean {
  if (!env) return false
  return WRITE_CREDENTIAL_ENV_KEYS.some((key) => Boolean(env[key]?.trim()))
}

export function joinWorktreePath(
  worktree: string,
  relative: string,
): string | null {
  const cleaned = relative.replaceAll("\\", "/").replace(/^\/+/, "")
  const parts = cleaned.split("/").filter((part) => part && part !== ".")
  if (parts.some((part) => part === "..")) return null
  const joined = [worktree.replace(/\/+$/, ""), ...parts].join("/")
  return resolvedPathInsideRoot(worktree, joined)
}

/** POSIX-style resolve without following symlinks. */
export function resolvedPathInsideRoot(
  root: string,
  candidate: string,
): string | null {
  const resolvedRoot = posixResolve(root.replace(/\/+$/, "") || "/")
  const resolved = posixResolve(candidate)
  if (resolved === resolvedRoot) return candidate
  if (resolved.startsWith(`${resolvedRoot}/`)) return candidate
  return null
}

export async function realpathInsideRoot(input: {
  root: string
  candidate: string
  realpath: (path: string) => Promise<string>
}): Promise<string | null> {
  const joined = resolvedPathInsideRoot(input.root, input.candidate)
  if (!joined) return null
  try {
    const real = await input.realpath(joined)
    return resolvedPathInsideRoot(input.root, real) ? joined : null
  } catch {
    return joined
  }
}

function posixResolve(input: string): string {
  const absolute = input.startsWith("/") ? input : `/${input}`
  const parts: string[] = []
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `/${parts.join("/")}`
}

export function parseGitStatusPorcelain(stdout: string): {
  files: string[]
  deletePaths: string[]
} {
  const files: string[] = []
  const deletePaths: string[] = []
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd()
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    const path = line.slice(3).trim()
    if (!path) continue
    if (code.includes("D") && !code.includes("A") && !code.includes("M")) {
      deletePaths.push(path)
      continue
    }
    files.push(
      path.includes(" -> ") ? (path.split(" -> ").at(-1) ?? path) : path,
    )
  }
  return { files, deletePaths }
}

async function execOrThrow(
  exec: JobWorktreeExec,
  command: string,
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await exec(command, { ...options, env: {} })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Command failed: ${command}`)
  }
  return result
}

export async function runJobWorktree(input: {
  worktree: string
  repoRoot?: string
  files: ReadonlyArray<{ path: string; content: string }>
  deletePaths?: ReadonlyArray<string>
  exec: JobWorktreeExec
  fs: JobWorktreeFs
  agent?: (worktreePath: string) => Promise<void>
}): Promise<{
  files: Array<{ path: string; content: string }>
  deletePaths: string[]
}> {
  const repoRoot = input.repoRoot ?? "."
  let added = false
  try {
    await execOrThrow(input.exec, `git worktree add ${input.worktree} HEAD`, {
      cwd: repoRoot,
    })
    added = true
    for (const file of input.files) {
      const dest = joinWorktreePath(input.worktree, file.path)
      if (!dest) continue
      await input.fs.mkdir(dest.split("/").slice(0, -1).join("/"))
      await input.fs.write(dest, file.content)
    }
    for (const path of input.deletePaths ?? []) {
      const dest = joinWorktreePath(input.worktree, path)
      if (!dest) continue
      await input.fs.remove(dest)
    }
    await input.agent?.(input.worktree)
    await execOrThrow(input.exec, "git add -A", { cwd: input.worktree })
    const status = await execOrThrow(input.exec, "git status --porcelain", {
      cwd: input.worktree,
    })
    const changed = parseGitStatusPorcelain(status.stdout)
    const files: Array<{ path: string; content: string }> = []
    for (const path of changed.files) {
      const dest = joinWorktreePath(input.worktree, path)
      if (!dest) continue
      files.push({ path, content: await input.fs.read(dest) })
    }
    return { files, deletePaths: changed.deletePaths }
  } finally {
    if (added) {
      await execOrThrow(
        input.exec,
        `git worktree remove --force ${input.worktree}`,
        { cwd: repoRoot },
      )
    }
  }
}
