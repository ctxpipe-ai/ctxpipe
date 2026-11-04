import { execFileSync } from "node:child_process"

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
}

/** The files that `base...HEAD` changed, as `{ status, path }` (A, M, D, R…). */
export function changedFiles(root, base) {
  git(root, ["rev-parse", "--verify", `${base}^{commit}`])
  return git(root, ["diff", "--name-status", "--no-renames", `${base}...HEAD`])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split("\t")
      return { status: status[0], path }
    })
}

/** The line numbers that `base...HEAD` added to one file. */
export function addedLines(root, base, path) {
  const lines = new Set()
  const diff = git(root, [
    "diff",
    "--unified=0",
    "--no-renames",
    `${base}...HEAD`,
    "--",
    path,
  ])
  for (const match of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1])
    const count = match[2] === undefined ? 1 : Number(match[2])
    for (let line = start; line < start + count; line += 1) lines.add(line)
  }
  return lines
}

/** The text of a file at HEAD, or undefined when it does not exist. */
export function fileAtHead(root, path) {
  try {
    return git(root, ["show", `HEAD:${path}`])
  } catch {
    return undefined
  }
}
