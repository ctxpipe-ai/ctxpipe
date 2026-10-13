import { spawn } from "node:child_process"

/** Runs git with an optional stdin; the exit status and stderr decide the result. */
export function runGit(
  cwd: string,
  args: string[],
  options: { input?: Buffer | string; env?: NodeJS.ProcessEnv } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out))
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
