import { randomUUID } from "node:crypto"
import { PassThrough } from "node:stream"
import type { ExecResult } from "@tanstack/ai-sandbox"
import Docker from "dockerode"

/*
 * Root commands for an ingest sandbox. Only root prepares /ctxpipe and starts
 * agent commands (as the agent user, through `runuser`). Docker runs an exec
 * as uid 0 in the container; Vercel uses the SDK's `sudo` option. Both run
 * the same scripts.
 */

/**
 * Runs a shell script as root in the sandbox. With a `signal`, an abort ends
 * the script's whole process group in the sandbox, and the promise rejects
 * with the signal's reason only after the group is gone.
 */
export type RootExec = (
  script: string,
  options?: { signal?: AbortSignal },
) => Promise<ExecResult>

/** Root-only folder for the process group id of each signalled exec. */
const EXEC_GROUPS = "/run/ctxpipe-exec"

export function dockerRootExec(
  containerId: string,
  docker: Docker = new Docker({ timeout: 120_000 }),
): RootExec {
  const container = docker.getContainer(containerId)
  async function exec(cmd: string[]): Promise<ExecResult> {
    const exec = await container.exec({
      Cmd: cmd,
      User: "0",
      AttachStdout: true,
      AttachStderr: true,
    })
    const stream = await exec.start({})
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const out: Buffer[] = []
    const err: Buffer[] = []
    stdout.on("data", (chunk: Buffer) => out.push(chunk))
    stderr.on("data", (chunk: Buffer) => err.push(chunk))
    docker.modem.demuxStream(stream, stdout, stderr)
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve)
      stream.on("error", reject)
    })
    const { ExitCode } = await exec.inspect()
    return {
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
      exitCode: ExitCode ?? -1,
    }
  }
  return async (script, options) => {
    const signal = options?.signal
    if (!signal) return exec(["sh", "-c", script])
    signal.throwIfAborted()
    // `setsid -w` makes a new process group (its id is the shell's pid) and
    // waits for it. The id goes to a root-only file, so an abort can end
    // the group, also the agent processes that `runuser` started.
    const file = `${EXEC_GROUPS}/${randomUUID()}`
    const wrapper = `mkdir -p -m 700 ${EXEC_GROUPS} && echo $$ > ${file} && { sh -c "$1"; code=$?; rm -f ${file}; exit $code; }`
    let killed: Promise<unknown> | undefined
    const onAbort = () => {
      // TERM, then KILL after 5 seconds; return when no process of the
      // group is left. A group that has not written its file yet gets 5
      // seconds to do it. Dash's `kill` refuses `--`, so the group id comes
      // directly after the signal. PID 1 of the sandbox does not reap
      // orphans, so a zombie of the group does not count as alive.
      killed = exec([
        "sh",
        "-c",
        `i=0; while [ ! -f ${file} ] && [ $i -lt 50 ]; do i=$((i+1)); sleep 0.1; done; [ -f ${file} ] || exit 0; g=$(cat ${file}); live() { ps -eo pgid=,stat= | awk -v g="$g" '$1 == g && $2 !~ /^Z/ { f = 1 } END { exit !f }'; }; kill -TERM -$g 2>/dev/null; i=0; while live; do i=$((i+1)); [ $i -ge 50 ] && kill -KILL -$g 2>/dev/null; sleep 0.1; done; rm -f ${file}`,
      ])
    }
    signal.addEventListener("abort", onAbort, { once: true })
    const running = exec(["setsid", "-w", "sh", "-c", wrapper, "sh", script])
    try {
      const result = await running
      if (killed) {
        await killed
        throw signal.reason
      }
      return result
    } catch (error) {
      if (killed) await killed.catch(() => undefined)
      throw killed ? signal.reason : error
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }
}

type VercelCommandSandbox = {
  runCommand: (input: {
    cmd: string
    args: string[]
    sudo: boolean
  }) => Promise<{
    exitCode: number | null
    output: (stream: "stdout" | "stderr") => Promise<string>
  }>
}

export function vercelRootExec(sandbox: VercelCommandSandbox): RootExec {
  return async (script) => {
    const finished = await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", script],
      sudo: true,
    })
    const [stdout, stderr] = await Promise.all([
      finished.output("stdout"),
      finished.output("stderr"),
    ])
    return { stdout, stderr, exitCode: finished.exitCode ?? -1 }
  }
}

/** Run as root; throw with the stderr on a nonzero exit. */
export async function runAsRoot(root: RootExec, script: string): Promise<void> {
  const result = await root(script)
  if (result.exitCode !== 0)
    throw new Error(
      `Ingest root command failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`,
    )
}
