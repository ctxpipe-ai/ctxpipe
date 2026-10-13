import { PassThrough } from "node:stream"
import Docker from "dockerode"
import type { RunAsRoot } from "./skill-bundle.js"

/*
 * Root commands for ingest prepare. The agent runs as the sandbox user, so
 * only prepare can make `/ctxpipe/skills` and the context checkouts that the
 * user cannot change. Docker runs an exec as uid 0 in the container; Vercel
 * uses the SDK's `sudo` option. Both run the same script.
 */

export function dockerRunAsRoot(
  containerId: string,
  docker: Docker = new Docker({ timeout: 120_000 }),
): RunAsRoot {
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
    const chunks: Buffer[] = []
    stderr.on("data", (chunk: Buffer) => chunks.push(chunk))
    stdout.resume()
    docker.modem.demuxStream(stream, stdout, stderr)
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve)
      stream.on("error", reject)
    })
    const { ExitCode } = await exec.inspect()
    if (ExitCode !== 0)
      throw new Error(
        `Ingest root command failed (exit ${ExitCode}): ${Buffer.concat(chunks).toString("utf8").slice(-500)}`,
      )
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

export function vercelRunAsRoot(sandbox: VercelCommandSandbox): RunAsRoot {
  return async (script) => {
    const finished = await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", script],
      sudo: true,
    })
    if (finished.exitCode !== 0)
      throw new Error(
        `Ingest root command failed (exit ${finished.exitCode}): ${(await finished.output("stderr")).slice(-500)}`,
      )
  }
}
