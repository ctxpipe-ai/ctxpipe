import {
  isConversationSandboxListedPath,
  splitGitNulPaths,
} from "./conversation-files.js"
import type { JobSandboxHandle } from "./job-worktree.js"

export type ConversationTurnFile = {
  path: string
  status: "added" | "modified" | "deleted"
  additions: number
  deletions: number
}

async function gitOk(
  handle: JobSandboxHandle,
  command: string,
  env: Record<string, string>,
): Promise<string> {
  const result = await handle.exec(command, { env })
  if (result.exitCode !== 0)
    throw new Error(result.stderr || `Command failed: ${command}`)
  return result.stdout
}

/**
 * Writes the work tree, with untracked files that git does not ignore, as a
 * tree object. A copy of the index is used, so the real index and the work
 * tree do not change. A ref under refs/ctxpipe/turns keeps the tree from
 * garbage collection.
 */
export async function snapshotConversationTurn(
  handle: JobSandboxHandle,
  runId: string,
  phase: "start" | "end",
): Promise<string> {
  const stdout = await gitOk(
    handle,
    [
      "idx=$(mktemp) || exit 1",
      "trap 'rm -f \"$idx\"' EXIT",
      "src=$(git rev-parse --git-path index)",
      // git does not accept an empty index file; no file is an empty index.
      'if [ -f "$src" ]; then cp "$src" "$idx"; else rm -f "$idx"; fi',
      'GIT_INDEX_FILE="$idx" git add -A >/dev/null',
      'tree=$(GIT_INDEX_FILE="$idx" git write-tree)',
      'git update-ref "refs/ctxpipe/turns/$CTXPIPE_RUN_ID/$CTXPIPE_PHASE" "$tree"',
      'printf "%s" "$tree"',
    ].join(" && "),
    {
      CTXPIPE_RUN_ID: runId.replace(/[^A-Za-z0-9_-]/g, "_"),
      CTXPIPE_PHASE: phase,
    },
  )
  const tree = stdout.trim()
  if (!/^[0-9a-f]{40,64}$/.test(tree))
    throw new Error("Turn snapshot did not give a tree")
  return tree
}

/** The files that differ between two turn snapshots, with line counts. */
export async function conversationTurnFiles(
  handle: JobSandboxHandle,
  start: string,
  end: string,
): Promise<ConversationTurnFile[]> {
  if (start === end) return []
  const env = { CTXPIPE_START: start, CTXPIPE_END: end }
  const [names, numstat] = await Promise.all([
    gitOk(
      handle,
      'git diff --no-renames --name-status -z "$CTXPIPE_START" "$CTXPIPE_END"',
      env,
    ),
    gitOk(
      handle,
      'git diff --no-renames --numstat -z "$CTXPIPE_START" "$CTXPIPE_END"',
      env,
    ),
  ])
  const counts = new Map<string, { additions: number; deletions: number }>()
  for (const record of splitGitNulPaths(numstat)) {
    const [added, deleted, ...rest] = record.split("\t")
    const path = rest.join("\t")
    if (!path) continue
    counts.set(path, {
      additions: Number.parseInt(added ?? "", 10) || 0,
      deletions: Number.parseInt(deleted ?? "", 10) || 0,
    })
  }
  const files: ConversationTurnFile[] = []
  const fields = splitGitNulPaths(names)
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const code = fields[index]
    const path = fields[index + 1] ?? ""
    if (!isConversationSandboxListedPath(path)) continue
    files.push({
      path,
      status: code === "A" ? "added" : code === "D" ? "deleted" : "modified",
      additions: counts.get(path)?.additions ?? 0,
      deletions: counts.get(path)?.deletions ?? 0,
    })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** The before and after bodies of the given files in one turn. */
export async function conversationTurnDiff(
  handle: JobSandboxHandle,
  start: string,
  end: string,
  paths: string[],
): Promise<
  Array<{ path: string; oldBody: string | null; body: string | null }>
> {
  const show = async (tree: string, path: string) => {
    const result = await handle.exec('git show "$CTXPIPE_TREE:$CTXPIPE_PATH"', {
      env: { CTXPIPE_TREE: tree, CTXPIPE_PATH: path },
    })
    return result.exitCode === 0 ? result.stdout : null
  }
  const items = []
  for (const path of paths) {
    if (!isConversationSandboxListedPath(path)) continue
    items.push({
      path,
      oldBody: await show(start, path),
      body: await show(end, path),
    })
  }
  return items
}
