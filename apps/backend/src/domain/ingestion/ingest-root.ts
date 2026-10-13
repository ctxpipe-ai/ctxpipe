import { PassThrough } from "node:stream"
import type { ExecResult } from "@tanstack/ai-sandbox"
import Docker from "dockerode"

/*
 * Root commands for an ingest sandbox. Only root prepares /ctxpipe and starts
 * agent commands (as the agent user, through `runuser`). Docker runs an exec
 * as uid 0 in the container; Vercel uses the SDK's `sudo` option. Both run
 * the same scripts.
 */

/** Runs a shell script as root in the sandbox. */
export type RootExec = (script: string) => Promise<ExecResult>

export function dockerRootExec(
  containerId: string,
  docker: Docker = new Docker({ timeout: 120_000 }),
): RootExec {
  return async (script) => {
    const exec = await docker.getContainer(containerId).exec({
      Cmd: ["sh", "-c", script],
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
