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

/** Runs one command (no shell) as root in the sandbox. */
type RootCommand = (cmd: string[]) => Promise<ExecResult>

/**
 * A `RootExec` from a root command. With a `signal`, the script runs in its
 * own process group, and an abort ends that group (see `RootExec`).
 */
function signalledRootExec(exec: RootCommand): RootExec {
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
      // orphans, so a zombie of the group does not count as alive. The
      // group and state of each process come from /proc, because a Vercel
      // sandbox has no `ps`: in /proc/<pid>/stat, after the last ") ", the
      // first field is the state and the third field is the group id.
      killed = exec([
        "sh",
        "-c",
        `i=0; while [ ! -f ${file} ] && [ $i -lt 50 ]; do i=$((i+1)); sleep 0.1; done; [ -f ${file} ] || exit 0; g=$(cat ${file}); live() { for s in /proc/[0-9]*/stat; do r=$(sed 's/.*) //' "$s" 2>/dev/null) || continue; set -- $r; [ "$3" = "$g" ] && [ "$1" != Z ] && return 0; done; return 1; }; kill -TERM -$g 2>/dev/null; i=0; while live; do i=$((i+1)); [ $i -ge 50 ] && kill -KILL -$g 2>/dev/null; sleep 0.1; done; rm -f ${file}`,
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

export function dockerRootExec(
  containerId: string,
  docker: Docker = new Docker({ timeout: 120_000 }),
): RootExec {
  const container = docker.getContainer(containerId)
  return signalledRootExec(async (cmd) => {
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
  })
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

/** Root through the Vercel SDK's `sudo` option; the same scripts as Docker. */
export function vercelRootExec(sandbox: VercelCommandSandbox): RootExec {
  return signalledRootExec(async ([cmd = "sh", ...args]) => {
    const finished = await sandbox.runCommand({ cmd, args, sudo: true })
    const [stdout, stderr] = await Promise.all([
      finished.output("stdout"),
      finished.output("stderr"),
    ])
    return { stdout, stderr, exitCode: finished.exitCode ?? -1 }
  })
}

/** Run as root; throw with the stderr on a nonzero exit. */
export async function runAsRoot(root: RootExec, script: string): Promise<void> {
  const result = await root(script)
  if (result.exitCode !== 0)
    throw new Error(
      `Ingest root command failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`,
    )
}
