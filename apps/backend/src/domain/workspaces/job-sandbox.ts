import type { JobSandboxHandle, JobWorktreeExec } from "./job-worktree.js"

type TanstackLikeHandle = {
  id?: string
  process: {
    exec: JobWorktreeExec
  }
  fs: JobSandboxHandle["fs"]
  git?: {
    clone: (input: {
      url: string
      ref?: string
      auth?: { token: string }
      depth?: number | "full"
    }) => Promise<void>
  }
  destroy: () => Promise<void>
}

/**
 * Shell prefix for each backend command in a sandbox. Backend git commands
 * ignore the programs that the repository config defines: hooks, fsmonitor,
 * the external diff, the filter drivers, and the merge drivers. A merge
 * driver becomes `git merge-file`, the same text merge that git uses with no
 * driver. The `GIT_CONFIG_*` entries have the precedence of `git -c`, and the
 * git processes that git starts get them too. An empty `diff.external` stops
 * a diff that does not use `--no-ext-diff`, so each backend diff uses
 * `--no-ext-diff --no-textconv`.
 */
export const SANDBOX_GIT_GUARD = String.raw`export GIT_CONFIG_COUNT=3 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0= GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=/dev/null GIT_CONFIG_KEY_2=diff.external GIT_CONFIG_VALUE_2=
ctxpipe_git_set() {
  eval "export GIT_CONFIG_KEY_$GIT_CONFIG_COUNT=\"\$1\" GIT_CONFIG_VALUE_$GIT_CONFIG_COUNT=\"\$2\""
  GIT_CONFIG_COUNT=$((GIT_CONFIG_COUNT + 1))
}
while IFS=' ' read -r ctxpipe_section ctxpipe_name; do
  case "$ctxpipe_section" in
  filter)
    ctxpipe_git_set "filter.$ctxpipe_name.clean" ""
    ctxpipe_git_set "filter.$ctxpipe_name.smudge" ""
    ctxpipe_git_set "filter.$ctxpipe_name.process" ""
    ctxpipe_git_set "filter.$ctxpipe_name.required" false
    ;;
  merge)
    ctxpipe_git_set "merge.$ctxpipe_name.driver" "git merge-file --marker-size=%L %A %O %B"
    ctxpipe_git_set "merge.$ctxpipe_name.recursive" text
    ;;
  esac
done <<CTXPIPE_DRIVERS
$(git config --name-only --get-regexp '^(filter|merge)[.].*[.]' 2>/dev/null | sed -n -e 's/^filter[.]\(.*\)[.][^.]*$/filter \1/p' -e 's/^merge[.]\(.*\)[.][^.]*$/merge \1/p' | sort -u)
CTXPIPE_DRIVERS
unset ctxpipe_section ctxpipe_name
unset -f ctxpipe_git_set
`

export function adaptTanstackHandle(
  handle: TanstackLikeHandle,
  signal?: AbortSignal,
): JobSandboxHandle {
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
    signal?.throwIfAborted()
    const result = await operation()
    signal?.throwIfAborted()
    return result
  }
  return {
    exec: (command, options) =>
      checked(() =>
        handle.process.exec(`${SANDBOX_GIT_GUARD}${command}`, {
          ...options,
          signal:
            signal && options?.signal
              ? AbortSignal.any([signal, options.signal])
              : (signal ?? options?.signal),
        }),
      ),
    fs: signal
      ? {
          read: (path) => checked(() => handle.fs.read(path, { signal })),
          write: (path, data) =>
            checked(() => handle.fs.write(path, data, { signal })),
          mkdir: (path) => checked(() => handle.fs.mkdir(path, { signal })),
          remove: (path) => checked(() => handle.fs.remove(path, { signal })),
        }
      : handle.fs,
  }
}
