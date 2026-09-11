import { execFile, spawn } from "node:child_process"
import { createServer } from "node:net"
import { promisify } from "node:util"

/** Serve only the disposable fixture repository to real isolated providers. */
export async function withNativeGitRemote<T>(
  directory: string,
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const allocator = createServer()
  await new Promise<void>((resolve, reject) => {
    allocator.once("error", reject)
    allocator.listen(0, "0.0.0.0", resolve)
  })
  const address = allocator.address()
  if (!address || typeof address === "string")
    throw new Error("Native Git fixture port missing")
  await new Promise<void>((resolve, reject) =>
    allocator.close((error) => (error ? reject(error) : resolve())),
  )
  const daemon = spawn(
    "git",
    [
      "daemon",
      "--verbose",
      "--export-all",
      "--strict-paths",
      "--listen=0.0.0.0",
      `--port=${address.port}`,
      `--base-path=${directory}`,
      `${directory}/.git`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  )
  const closed = new Promise<void>((resolve) =>
    daemon.once("close", () => resolve()),
  )
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Native Git fixture did not start")),
        5_000,
      )
      let output = ""
      daemon.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      daemon.once("exit", (code) => {
        clearTimeout(timer)
        reject(new Error(`Native Git fixture exited ${code}: ${output}`))
      })
      daemon.stderr.on("data", (data: Buffer) => {
        output += data.toString()
        if (output.includes("Ready to rumble")) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    await promisify(execFile)(
      "git",
      ["ls-remote", `git://127.0.0.1:${address.port}/.git`, "HEAD"],
      { timeout: 5_000 },
    )
    return await fn(`git://host.docker.internal:${address.port}/.git`)
  } finally {
    daemon.kill("SIGTERM")
    await closed
  }
}
