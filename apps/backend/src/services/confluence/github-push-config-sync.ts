import { workspaceRepositoryPath } from "../git/root-folder.js"

const GIT_EMPTY_TREE_SHA = "0000000000000000000000000000000000000000"

/**
 * The check of one GitHub push against a connector config file. `path` is
 * relative to the Workspace root folder (CTX-709), and each org can have a
 * different root folder on the repository:
 *
 * - `mayTouch` is the check before any org lookup. It is false only when no
 *   pushed path can be the file and GitHub cannot compare the two commits.
 * - `touches(rootPath, compare)` is the check for one root folder. It reads
 *   the commit lists first. GitHub sometimes sends incomplete lists, so when
 *   the lists do not name the file and both commits exist, it calls
 *   `compare` with the file path below the root folder.
 */
export function connectorConfigPush(input: {
  commits?: Array<{
    added?: string[]
    modified?: string[]
    removed?: string[]
  }>
  before?: string
  after?: string
  path: string
}) {
  const pushed = new Set<string>()
  for (const commit of input.commits ?? [])
    for (const path of [
      ...(commit.added ?? []),
      ...(commit.modified ?? []),
      ...(commit.removed ?? []),
    ])
      pushed.add(path)
  const { before, after } = input
  const shas =
    before &&
    after &&
    before !== GIT_EMPTY_TREE_SHA &&
    after !== GIT_EMPTY_TREE_SHA
      ? { before, after }
      : null
  return {
    mayTouch:
      shas !== null ||
      [...pushed].some(
        (path) => path === input.path || path.endsWith(`/${input.path}`),
      ),
    async touches(
      rootPath: string,
      compare: (path: string, base: string, head: string) => Promise<boolean>,
    ): Promise<boolean> {
      const path = workspaceRepositoryPath(rootPath, input.path)
      if (pushed.has(path)) return true
      return shas ? compare(path, shas.before, shas.after) : false
    },
  }
}
