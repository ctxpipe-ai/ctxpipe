import type { JobSandboxHandle, JobWorktreeExec } from "./job-worktree.js"

export type TanstackLikeHandle = {
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
 * the external diff, and the clean, smudge, and process filters. The
 * `GIT_CONFIG_*` entries have the precedence of `git -c`, and the git
 * processes that git starts get them too. An empty `diff.external` stops a
 * diff that does not use `--no-ext-diff`, so each backend diff uses
 * `--no-ext-diff --no-textconv`.
 */
export const SANDBOX_GIT_GUARD = String.raw`export GIT_CONFIG_COUNT=3 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0= GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=/dev/null GIT_CONFIG_KEY_2=diff.external GIT_CONFIG_VALUE_2=
while IFS= read -r ctxpipe_filter; do
  [ -n "$ctxpipe_filter" ] || continue
  for ctxpipe_key in clean smudge process required; do
    ctxpipe_value=
    [ "$ctxpipe_key" = required ] && ctxpipe_value=false
    eval "export GIT_CONFIG_KEY_$GIT_CONFIG_COUNT=\"filter.\$ctxpipe_filter.\$ctxpipe_key\" GIT_CONFIG_VALUE_$GIT_CONFIG_COUNT=\$ctxpipe_value"
    GIT_CONFIG_COUNT=$((GIT_CONFIG_COUNT + 1))
  done
done <<CTXPIPE_FILTERS
$(git config --name-only --get-regexp '^filter[.]' 2>/dev/null | sed -n 's/^filter[.]\(.*\)[.][^.]*$/\1/p' | sort -u)
CTXPIPE_FILTERS
unset ctxpipe_filter ctxpipe_key ctxpipe_value
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
