/** One change in the output of `git diff --name-status -z`. */
type GitNameStatus = { status: string; from: string; to: string }

/**
 * Parses the output of `git diff --name-status -z` (or `diff-tree`). A rename
 * or a copy (status `R…` or `C…`) has two paths; each other change has one
 * path, which is both `from` and `to`.
 */
export function parseNameStatus(output: Buffer | string): GitNameStatus[] {
  const fields = output.toString("utf8").split("\0")
  const changes: GitNameStatus[] = []
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++] ?? ""
    if (!status) break
    const from = fields[index++] ?? ""
    const to = /^[RC]/.test(status) ? (fields[index++] ?? "") : from
    changes.push({ status, from, to })
  }
  return changes
}
