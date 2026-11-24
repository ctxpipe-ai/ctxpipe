import { type ChildProcess, spawn } from "node:child_process"
import type { Writable } from "node:stream"

/**
 * Stop Git and the helper processes that it started (`git-remote-https`,
 * `fetch-pack`). On Linux, a helper stays alive when Git stops, keeps the
 * output pipes open, and waits for a stalled Git host forever (CTX-1601).
 * The child must have started with `detached: true`, so that it leads its own
 * process group.
 */
export function stopGitProcessGroup(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM")
  } catch {
    // The group has exited.
  }
}

/**
 * Start Git in its own process group, and collect its output like
 * `execFile`: a failure has `cmd`, `code`, `signal`, `killed` (Git stopped
 * at `timeoutMs`, at the output limit or by `stop`), `stdout`, and `stderr`.
 * Each output stream has a limit of `maxBuffer` bytes. `stop` ends the whole
 * process group.
 */
export function startGitProcess(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number },
): {
  done: Promise<Buffer>
  stop: () => void
  stdin: Writable | null
} {
  const child = spawn("git", args, { env: options.env, detached: true })
  let killed = false
  const stop = () => {
    killed = true
    stopGitProcessGroup(child)
  }
  const done = new Promise<Buffer>((resolve, reject) => {
    const limit = options.maxBuffer ?? 64 * 1024 * 1024
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    let failure: Error | undefined
    for (const name of ["stdout", "stderr"] as const) {
      let size = 0
      child[name].on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size <= limit) output[name].push(chunk)
        else if (!failure) {
          failure = Object.assign(
            new Error(`${name} maxBuffer length exceeded`),
            { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
          )
          stop()
        }
      })
    }
    const timer = options.timeoutMs
      ? setTimeout(stop, options.timeoutMs)
      : undefined
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(output.stdout)
      if (!failure && code === 0) {
        resolve(stdout)
        return
      }
      const stderr = Buffer.concat(output.stderr)
      const cmd = `git ${args.join(" ")}`
      reject(
        Object.assign(
          failure ?? new Error(`Command failed: ${cmd}\n${stderr.toString()}`),
          { cmd, killed, signal, stdout, stderr },
          failure ? {} : { code },
        ),
      )
    }
    // A process that did not start emits only `error`; the spawn retry
    // (CTX-952) reads its `code` and `syscall`.
    child.on("error", (error) => {
      failure ??= error
      if (child.pid === undefined) settle(null, null)
    })
    child.on("close", settle)
  })
  return { done, stop, stdin: child.stdin }
}
