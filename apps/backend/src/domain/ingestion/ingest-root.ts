import { randomUUID } from "node:crypto"
import { PassThrough } from "node:stream"
import type { ExecResult } from "@tanstack/ai-sandbox"
import Docker from "dockerode"
import {
  OPENCODE_ERROR,
  OPENCODE_STEP_FINISH,
} from "./ingest-opencode-usage.js"

/*
 * Root commands for an ingest sandbox. Only root prepares /ctxpipe and starts
 * agent commands (as the agent user, through `runuser`). Docker runs an exec
 * as uid 0 in the container; Vercel uses the SDK's `sudo` option. Both run
 * the same scripts.
 */

/**
 * Runs a shell script as root in the sandbox. With a `signal`, an abort ends
 * the script's whole process group in the sandbox and each process of the
 * agent user (also one that left the group with `setsid`), and the promise
 * rejects with the signal's reason only after they are gone.
 */
export type RootExec = (
  script: string,
  options?: { signal?: AbortSignal },
) => Promise<RootResult>

/**
 * The result of a root command. `stdoutTruncated`: the command wrote more
 * stdout than the worker keeps, so a part of it is not in `stdout`.
 */
export type RootResult = ExecResult & { stdoutTruncated?: boolean }

/** The agent user on every provider. It is in no sudoers file. */
export const INGEST_AGENT_USER = "ctxpipe-agent"

/**
 * Stop every process of the agent user, again and again until none is left,
 * so a process that forks while it is stopped is also stopped. The real uid
 * in /proc/<pid>/status counts; a process cannot hide it. Each round freezes
 * all found processes first, so none can fork or write while the round kills
 * them. A zombie (State `Z`) has nothing left to kill, and PID 1 may never
 * reap it, so `found` skips it. A process can exit before its signal arrives; the script uses
 * `|| true` there, because under `set -e` that failed `kill` stops the whole
 * script with no message.
 */
export const STOP_AGENT_PROCESSES = `uid=$(id -u ${INGEST_AGENT_USER})
found() {
  for d in /proc/[0-9]*; do
    u=$(sed -n 's/^Uid:[[:space:]]*\\([0-9]*\\).*/\\1/p' "$d/status" 2>/dev/null || true)
    st=$(sed -n 's/^State:[[:space:]]*\\(.\\).*/\\1/p' "$d/status" 2>/dev/null || true)
    if [ "$u" = "$uid" ] && [ "$st" != "Z" ]; then echo "\${d#/proc/}"; fi
  done
  true
}
i=0
while [ "$i" -lt 100 ]; do
  left=$(found)
  [ -z "$left" ] && break
  for p in $left; do kill -STOP "$p" 2>/dev/null || true; done
  for p in $left; do kill -KILL "$p" 2>/dev/null || true; done
  sleep 0.1
  i=$((i + 1))
done
if [ -n "$(found)" ]; then echo "Agent processes are left: $(found)" >&2; exit 1; fi`

/** Root-only folder for the process group id of each signalled exec. */
const EXEC_GROUPS = "/run/ctxpipe-exec"

/** Runs one command (no shell) as root in the sandbox. */
type RootCommand = (cmd: string[]) => Promise<RootResult>

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
      // TERM, then KILL after 5 seconds; go on when no process of the
      // group is left. A group that has not written its file yet gets 5
      // seconds to do it. Dash's `kill` refuses `--`, so the group id comes
      // directly after the signal. PID 1 of the sandbox does not reap
      // orphans, so a zombie of the group does not count as alive. The
      // group and state of each process come from /proc, because a Vercel
      // sandbox has no `ps`: in /proc/<pid>/stat, after the last ") ", the
      // first field is the state and the third field is the group id.
      // Then stop each process of the agent user: an agent process can
      // leave the group (`setsid`, a double fork).
      killed = exec([
        "sh",
        "-c",
        [
          `i=0; while [ ! -f ${file} ] && [ $i -lt 50 ]; do i=$((i+1)); sleep 0.1; done; if [ -f ${file} ]; then g=$(cat ${file}); live() { for s in /proc/[0-9]*/stat; do r=$(sed 's/.*) //' "$s" 2>/dev/null) || continue; set -- $r; [ "$3" = "$g" ] && [ "$1" != Z ] && return 0; done; return 1; }; kill -TERM -$g 2>/dev/null; i=0; while live; do i=$((i+1)); [ $i -ge 50 ] && kill -KILL -$g 2>/dev/null; sleep 0.1; done; rm -f ${file}; fi`,
          `id -u ${INGEST_AGENT_USER} >/dev/null 2>&1 || exit 0`,
          STOP_AGENT_PROCESSES,
        ].join("\n"),
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
  // The client timeout is an idle timeout: it also ends an exec that writes
  // nothing for that long. A model step can write nothing for minutes, so
  // the timeout is longer than the step limit (`INGEST_STEP_LIMIT_MS`, 10
  // min), and the step limit ends a step.
  docker: Docker = new Docker({ timeout: 15 * 60_000 }),
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
    const output = boundedRootOutput()
    stdout.on("data", (chunk: Buffer) => output.add("stdout", chunk))
    stderr.on("data", (chunk: Buffer) => output.add("stderr", chunk))
    docker.modem.demuxStream(stream, stdout, stderr)
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve)
      stream.on("error", reject)
    })
    const { ExitCode } = await exec.inspect()
    return { ...output.result(), exitCode: ExitCode ?? -1 }
  })
}

type VercelCommandSandbox = {
  runCommand: (input: {
    cmd: string
    args: string[]
    sudo: boolean
  }) => Promise<{
    exitCode: number | null
    logs: () => AsyncIterable<{ stream: "stdout" | "stderr"; data: string }>
  }>
}

/**
 * Root through the Vercel SDK's `sudo` option; the same scripts as Docker.
 * The SDK's `output()` keeps the full stdout, the full stderr, and both
 * together in the heap. A command that writes much can fill the worker heap
 * (CTX-971), so this reads the log stream and keeps only the bounded part.
 */
export function vercelRootExec(sandbox: VercelCommandSandbox): RootExec {
  return signalledRootExec(async ([cmd = "sh", ...args]) => {
    const finished = await sandbox.runCommand({ cmd, args, sudo: true })
    const output = boundedRootOutput()
    for await (const line of finished.logs()) output.add(line.stream, line.data)
    return { ...output.result(), exitCode: finished.exitCode ?? -1 }
  })
}

/** The stdout that a root command keeps from its start, up to this cap. */
export const ROOT_STDOUT_MAX_BYTES = 8 * 1024 * 1024
/**
 * After the start of stdout is full, the `step_finish` and `error` lines of
 * `opencode run` that a root command still keeps, up to this cap. The usage
 * and the errors of a model step come from these lines.
 */
export const ROOT_STDOUT_EVENT_MAX_BYTES = 4 * 1024 * 1024
/** The longest event line that is kept after the start of stdout is full. */
const EVENT_LINE_MAX_BYTES = 64 * 1024
/** The stderr that a root command keeps: its last bytes, up to this cap. */
export const ROOT_STDERR_MAX_BYTES = 64 * 1024

const NEWLINE = 0x0a
const EVENT_PREFIXES = [
  Buffer.from(OPENCODE_STEP_FINISH),
  Buffer.from(OPENCODE_ERROR),
]

/**
 * The output of one root command, with a cap on each stream, so that a
 * command that writes gigabytes cannot fill the worker heap (CTX-971).
 * Stdout keeps its start, in full lines, up to `ROOT_STDOUT_MAX_BYTES`: the
 * callers parse it, and a parse of a cut stdout fails or a size check
 * refuses it. After that, stdout keeps only the `step_finish` and `error`
 * lines, up to `ROOT_STDOUT_EVENT_MAX_BYTES`, so that the usage of a long
 * model step stays. `stdoutTruncated` is true when stdout lost a byte.
 * Stderr keeps its end: the callers show the last part of it in the error.
 */
function boundedRootOutput() {
  const out: Buffer[] = []
  let outBytes = 0
  let eventBytes = 0
  /** The start of stdout is full; only event lines are kept now. */
  let headFull = false
  let truncated = false
  /** The parts of the current stdout line, before its newline. */
  let line: Buffer[] = []
  let lineBytes = 0
  /** The current line is too long to keep; drop it up to its newline. */
  let dropLine = false
  const err: Buffer[] = []
  let errBytes = 0

  const lineCap = () =>
    headFull ? EVENT_LINE_MAX_BYTES : ROOT_STDOUT_MAX_BYTES - outBytes
  const keepLine = (end: Buffer) => {
    const whole = Buffer.concat([...line, end])
    line = []
    lineBytes = 0
    if (!headFull && outBytes + whole.length <= ROOT_STDOUT_MAX_BYTES) {
      out.push(whole)
      outBytes += whole.length
      return
    }
    headFull = true
    truncated = true
    if (
      eventBytes + whole.length <= ROOT_STDOUT_EVENT_MAX_BYTES &&
      EVENT_PREFIXES.some((prefix) =>
        whole.subarray(0, prefix.length).equals(prefix),
      )
    ) {
      out.push(whole)
      eventBytes += whole.length
    }
  }
  const addStdout = (chunk: Buffer) => {
    let at = 0
    while (at < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, at)
      const end = newline === -1 ? chunk.length : newline + 1
      const part = chunk.subarray(at, end)
      at = end
      if (!dropLine && lineBytes + part.length > lineCap()) {
        // The line does not fit in the start of stdout: the start ends here.
        // It can still be an event line; one longer than that cap is dropped.
        headFull = true
        truncated = true
        if (lineBytes + part.length > lineCap()) {
          dropLine = true
          line = []
          lineBytes = 0
        }
      }
      if (dropLine) {
        if (newline !== -1) dropLine = false
        continue
      }
      if (newline === -1) {
        line.push(Buffer.from(part))
        lineBytes += part.length
      } else keepLine(part)
    }
  }
  return {
    add(stream: "stdout" | "stderr", data: Buffer | string) {
      const chunk = typeof data === "string" ? Buffer.from(data) : data
      if (stream === "stdout") {
        addStdout(chunk)
        return
      }
      err.push(chunk)
      errBytes += chunk.length
      while (
        err.length > 1 &&
        errBytes - (err[0]?.length ?? 0) >= ROOT_STDERR_MAX_BYTES
      )
        errBytes -= err.shift()?.length ?? 0
    },
    result(): { stdout: string; stderr: string; stdoutTruncated?: true } {
      // The last line has no newline.
      if (lineBytes > 0) keepLine(Buffer.alloc(0))
      const stderr = Buffer.concat(err)
      return {
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: stderr
          .subarray(Math.max(0, stderr.length - ROOT_STDERR_MAX_BYTES))
          .toString("utf8"),
        ...(truncated ? { stdoutTruncated: true as const } : {}),
      }
    },
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
