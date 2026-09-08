export type JobWorktreeExec = (
  command: string,
  options?: { cwd?: string; env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>

export type JobWorktreeFs = {
  write: (path: string, data: string) => Promise<void>
  read: (path: string) => Promise<string>
  remove: (path: string) => Promise<void>
  mkdir: (path: string) => Promise<void>
}

export type JobSandboxHandle = {
  exec: JobWorktreeExec
  fs: JobWorktreeFs
}
