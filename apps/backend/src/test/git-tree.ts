import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const trees: string[] = []

/** A temporary Git repository with one commit of `files` (path to text). */
export function commitGitTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "git-tree-"))
  trees.push(dir)
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })
  git("init", "-q")
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  git("add", ".")
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "x",
  )
  return dir
}

/** Remove each repository that `commitGitTree` made. */
export function removeGitTrees(): void {
  for (const dir of trees.splice(0))
    rmSync(dir, { recursive: true, force: true })
}
