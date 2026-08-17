import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

export const DEFAULT_MEMORY_ROOT = ".ai/memory"

/** Shared git toplevel resolution for init/status/doctor/capture. */
export function resolveRepoRoot(cwd = process.cwd()): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  })
  if (result.status === 0 && result.stdout) return result.stdout.trim()
  return cwd
}

export function resolveMemoryRoot(cwd: string): string {
  return resolve(cwd, DEFAULT_MEMORY_ROOT)
}
