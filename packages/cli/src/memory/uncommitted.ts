import { spawnSync } from "node:child_process"

export type UncommittedMemory = {
  /** Branch name, or `(detached)`. */
  branch: string
  /** Commit sha, or `(initial)` before the first commit. */
  head: string
  /** Repo-relative durable `.ai/memory` paths with uncommitted changes. */
  files: string[]
}

/** Durable memory not yet committed (the `events/` inbox excluded); null outside git. */
export function uncommittedMemory(repoRoot: string): UncommittedMemory | null {
  const result = spawnSync(
    "git",
    [
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
      "--",
      ".ai/memory",
      ":(exclude).ai/memory/events",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  )
  if (result.status !== 0 || typeof result.stdout !== "string") return null

  let branch = ""
  let head = ""
  const files: string[] = []
  const entries = result.stdout.split("\0")
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? ""
    if (entry.startsWith("# branch.head ")) branch = entry.slice(14)
    else if (entry.startsWith("# branch.oid ")) head = entry.slice(13)
    else if (entry.startsWith("1 ")) files.push(pathAfterFields(entry, 8))
    else if (entry.startsWith("2 ")) {
      files.push(pathAfterFields(entry, 9))
      i++ // rename/copy: the original path follows as its own entry
    } else if (entry.startsWith("u ")) files.push(pathAfterFields(entry, 10))
    else if (entry.startsWith("? ")) files.push(entry.slice(2))
  }
  return { branch, head, files }
}

function pathAfterFields(entry: string, fields: number): string {
  return entry.split(" ").slice(fields).join(" ")
}
