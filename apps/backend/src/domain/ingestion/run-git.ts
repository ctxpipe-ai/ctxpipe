import { spawn } from "node:child_process"

export class GitOutputTooLargeError extends Error {}

/**
 * Runs git with an optional stdin; the exit status and stderr decide the
 * result. Output larger than `maxOutputBytes` (default 256 MiB) stops git
 * and fails the call, so that a large repository cannot fill the memory.
 * `maxFileBytes` caps the size of each file that git writes (a download into
 * the object store); git then dies of signal 25 (SIGXFSZ). A shell that counts
 * `ulimit -f` in 1024-byte blocks allows up to twice that size. `env` adds to
 * the environment of the process; `cleanEnv` is the whole environment (a
 * plain git read, CTX-815). After `timeoutMs`, the call kills git and fails.
 */
export function runGit(
  cwd: string,
  args: string[],
  options: {
    input?: Buffer | string
    env?: NodeJS.ProcessEnv
    cleanEnv?: NodeJS.ProcessEnv
    maxOutputBytes?: number
    maxFileBytes?: number
    timeoutMs?: number
  } = {},
): Promise<Buffer> {
  const limit = options.maxOutputBytes ?? 256 * 1024 * 1024
  return new Promise((resolve, reject) => {
    const spawnOptions = {
      cwd,
      env: options.cleanEnv ?? { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
      // With a time limit, git and its helpers (`git-remote-http`,
      // `index-pack`) get their own process group, so the kill stops each.
      detached: options.timeoutMs !== undefined,
    }
    // POSIX `ulimit -f` counts 512-byte blocks; `exec` leaves one process.
    const child =
      options.maxFileBytes === undefined
        ? spawn("git", args, spawnOptions)
        : spawn(
            "sh",
            [
              "-c",
              'ulimit -f "$0" && exec git "$@"',
              String(Math.ceil(options.maxFileBytes / 512)),
              ...args,
            ],
            spawnOptions,
          )
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    let tooLarge = false
    let timedOut = false
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            try {
              if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
            } catch {
              child.kill("SIGKILL")
            }
          }, options.timeoutMs)
    child.stdout.on("data", (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > limit) {
        tooLarge = true
        out.length = 0
        child.kill()
        reject(
          new GitOutputTooLargeError(
            `git ${args[0]} output is larger than ${limit} bytes`,
          ),
        )
      } else out.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < 64) err.push(chunk)
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (tooLarge) return
      if (timedOut)
        reject(
          new Error(
            `git ${args[0]} did not finish in ${options.timeoutMs} ms, so it was stopped`,
          ),
        )
      else if (code === 0) resolve(Buffer.concat(out))
      else
        reject(
          new Error(
            `git ${args[0]} failed: ${Buffer.concat(err).toString().trim()}`,
          ),
        )
    })
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // Git can exit before it reads all of its input. Then its exit status
      // and its stderr give the result, not the broken pipe (EPIPE on macOS,
      // a premature close on Linux).
      if (error.code === "EPIPE" || error.code === "ERR_STREAM_PREMATURE_CLOSE")
        return
      child.kill()
      reject(error)
    })
    child.stdin.end(options.input ?? "")
  })
}
