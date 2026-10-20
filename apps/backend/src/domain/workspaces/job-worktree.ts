export type JobWorktreeExec = (
  command: string,
  options?: {
    cwd?: string
    env?: Record<string, string>
    signal?: AbortSignal
  },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>

export type JobWorktreeFs = {
  write: (
    path: string,
    data: string,
    options?: { signal?: AbortSignal },
  ) => Promise<void>
  read: (path: string, options?: { signal?: AbortSignal }) => Promise<string>
  remove: (path: string, options?: { signal?: AbortSignal }) => Promise<void>
  mkdir: (path: string, options?: { signal?: AbortSignal }) => Promise<void>
}

export type JobSandboxHandle = {
  exec: JobWorktreeExec
  fs: JobWorktreeFs
}
