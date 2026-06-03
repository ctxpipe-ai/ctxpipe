import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { resolve, join, isAbsolute } from "node:path"
import { spawnSync } from "node:child_process"

export const DEFAULT_MEMORY_ROOT = ".ai/memory"

/** Override for tests so we don't write into the real user home. */
export function memoryStateRoot(): string {
  const override = process.env.CTXPIPE_MEMORY_STATE_ROOT
  if (override && override.length > 0) {
    return override
  }
  return join(homedir(), ".config", "ctxpipe", "memory")
}

export type RepoFingerprint = string

export function detectRepoFingerprint(cwd: string): RepoFingerprint {
  const top = gitTopLevel(cwd) ?? cwd
  const worktree = gitCommonDir(cwd) ?? top
  const hash = createHash("sha256")
    .update(top)
    .update("\0")
    .update(worktree)
    .digest("hex")
    .slice(0, 16)
  return `repo_${hash}`
}

function gitTopLevel(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  })
  if (result.status === 0 && result.stdout) {
    return result.stdout.trim()
  }
  return null
}

function gitCommonDir(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
  })
  if (result.status === 0 && result.stdout) {
    const value = result.stdout.trim()
    return isAbsolute(value) ? value : resolve(cwd, value)
  }
  return null
}

export function ensureRepoStateDir(fingerprint: RepoFingerprint): string {
  const dir = join(memoryStateRoot(), "repos", fingerprint)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function repoStateDir(fingerprint: RepoFingerprint): string {
  return join(memoryStateRoot(), "repos", fingerprint)
}

export function runtimeStateFile(fingerprint: RepoFingerprint): string {
  return join(repoStateDir(fingerprint), "runtime.json")
}

export function hydrationManifestFile(fingerprint: RepoFingerprint): string {
  return join(repoStateDir(fingerprint), "hydration-manifest.json")
}

export function hydrationLockFile(fingerprint: RepoFingerprint): string {
  return join(repoStateDir(fingerprint), "hydration.lock")
}

export function agentMemoryHomeDir(fingerprint: RepoFingerprint): string {
  return join(repoStateDir(fingerprint), "agentmemory-home")
}

export function resolveMemoryRoot(cwd: string): string {
  return resolve(cwd, DEFAULT_MEMORY_ROOT)
}
