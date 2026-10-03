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
        handle.process.exec(command, {
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
