import { resolve } from "node:path"

export const DEFAULT_MEMORY_ROOT = ".ai/memory"

export function resolveMemoryRoot(cwd: string): string {
  return resolve(cwd, DEFAULT_MEMORY_ROOT)
}
