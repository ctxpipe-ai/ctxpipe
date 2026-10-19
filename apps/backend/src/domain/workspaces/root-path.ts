import { posix } from "node:path"
import { z } from "@hono/zod-openapi"
import { nativeGit } from "../../services/git/pack.js"
import { isInsideWorkspaceRoot } from "../../services/git/root-folder.js"

export {
  isInsideWorkspaceRoot,
  pathsOutsideWorkspaceRoot,
  workspaceRelativePath,
  workspaceRepositoryPath,
} from "../../services/git/root-folder.js"

/**
 * The root folder of a Workspace in its context repository (CTX-709). ctx|
 * reads and writes only below this folder. `""` is the repository root.
 * The stored value is normalized: relative, no trailing slash.
 */
export const workspaceRootPathSchema = z
  .string()
  .max(200)
  .transform((raw) => raw.trim().replace(/\/+$/, ""))
  .refine(
    (path) =>
      path === "" ||
      (path.split("/").length <= 16 &&
        path
          .split("/")
          .every(
            (segment) =>
              /^[A-Za-z0-9._-]+$/.test(segment) &&
              segment !== "." &&
              segment !== ".." &&
              segment.toLowerCase() !== ".git",
          )),
    "Use a relative folder path such as docs/context, with letters, digits, '.', '_', '-' and '/'",
  )

/**
 * The one place that reads the root folder of a Workspace. Today the value
 * comes from the Workspace row or a revision; a file in the repository can
 * feed it later.
 */
export function workspaceRootPath(
  source: { rootPath?: string | null } | null | undefined,
): string {
  return workspaceRootPathSchema.parse(source?.rootPath ?? "")
}

type WorkspaceRootViolation = {
  path: string
  reason: "outside_root" | "symlink_outside_root" | "submodule"
}

/**
 * Finds the changes from `base` to `head`, and in each commit between them,
 * that leave the root folder: a path outside it, a new symlink below it whose
 * target is outside it, or a new submodule (gitlink) below it, which points to
 * another repository. Each commit is also compared with its first parent,
 * because the history keeps a change that a later commit removes. Git records a write
 * through an existing symlink at the target path, so the path check also
 * catches that case.
 */
export async function gitChangesOutsideWorkspaceRoot(input: {
  directory: string
  base: string
  head: string
  rootPath: string
}): Promise<WorkspaceRootViolation[]> {
  const commits = (
    await nativeGit(input.directory, [
      "rev-list",
      "--parents",
      `${input.base}..${input.head}`,
    ])
  )
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
  // The net change from `base` comes first: a commit with no parent that
  // holds only the root folder looks clean against the empty tree, but it
  // drops each file outside the root.
  const violations = await changesOutsideRoot(input, input.base, input.head)
  for (const line of commits) {
    const [commit = "", parent] = line.split(" ")
    const before =
      parent ??
      (
        await nativeGit(
          input.directory,
          ["hash-object", "-t", "tree", "--stdin"],
          "",
        )
      )
        .toString("utf8")
        .trim()
    violations.push(...(await changesOutsideRoot(input, before, commit)))
  }
  const seen = new Set<string>()
  return violations.filter((violation) => {
    const key = `${violation.reason}\0${violation.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function changesOutsideRoot(
  input: { directory: string; rootPath: string },
  base: string,
  head: string,
): Promise<WorkspaceRootViolation[]> {
  const raw = (
    await nativeGit(input.directory, [
      "diff-tree",
      "-r",
      "-z",
      "--no-renames",
      base,
      head,
    ])
  ).toString("utf8")
  const fields = raw.split("\0")
  const violations: WorkspaceRootViolation[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const path = fields[i + 1] ?? ""
    // ":<old mode> <new mode> <old sha> <new sha> <status>"
    const [, newMode = "", , newSha = ""] = (fields[i] ?? "")
      .slice(1)
      .split(" ")
    if (!isInsideWorkspaceRoot(input.rootPath, path)) {
      violations.push({ path, reason: "outside_root" })
      continue
    }
    if (newMode === "160000") {
      violations.push({ path, reason: "submodule" })
      continue
    }
    if (newMode !== "120000") continue
    const target = (
      await nativeGit(input.directory, ["cat-file", "blob", newSha])
    ).toString("utf8")
    if (!symlinkStaysInRoot(input.rootPath, path, target))
      violations.push({ path, reason: "symlink_outside_root" })
  }
  return violations
}

function symlinkStaysInRoot(
  rootPath: string,
  path: string,
  target: string,
): boolean {
  if (target.startsWith("/") || target.includes("\\") || target.includes("\0"))
    return false
  const resolved = posix.normalize(posix.join(posix.dirname(path), target))
  if (resolved === (rootPath || ".")) return true
  return isInsideWorkspaceRoot(rootPath, resolved)
}
