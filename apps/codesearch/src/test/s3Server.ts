import { type ChildProcess, spawn } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { connect, createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { vi } from "vitest"

/**
 * A real S3-compatible server for tests: `versitygw posix` on a temporary
 * directory (the Docker test image has the pinned versitygw binary). Each
 * bucket is a directory under `root`, and each object is a file.
 *
 * Do not use `rclone serve s3`: two parallel uploads into the same new
 * directory make it answer 500 InternalError (CTX-1444).
 */
export async function startS3Server(): Promise<{
  bucket: string
  /** Every object key in the bucket, sorted. */
  keys: () => Promise<string[]>
  /** Points `CODESEARCH_SHARD_STORE` and the AWS SDK at this server. */
  stubEnv: (prefix: string) => void
  stop: () => Promise<void>
}> {
  const base = await mkdtemp(join(tmpdir(), "s3-server-"))
  const root = join(base, "data")
  // S3 refuses a bucket name with less than 3 characters.
  const bucket = "codesearch-test"
  await mkdir(join(root, bucket), { recursive: true })
  const accessKey = "codesearchtestaccess"
  const secretKey = "codesearchtestsecret"
  // versitygw does not report the port that it gets for port 0. It listens
  // on a Unix socket, and a TCP proxy on port 0 forwards to that socket, so
  // parallel test files never compete for a port.
  const socketPath = join(base, "s3.sock")
  const child: ChildProcess = spawn(
    "versitygw",
    ["--port", socketPath, "posix", root],
    {
      env: {
        PATH: process.env.PATH,
        ROOT_ACCESS_KEY: accessKey,
        ROOT_SECRET_KEY: secretKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  await new Promise<void>((resolve, reject) => {
    let output = ""
    const timer = setTimeout(
      () => reject(new Error(`versitygw did not start: ${output}`)),
      10_000,
    )
    const fail = (error: Error) => {
      clearTimeout(timer)
      reject(error)
    }
    child.on("error", fail)
    child.on("exit", (code) =>
      fail(new Error(`versitygw stopped (code ${code}): ${output}`)),
    )
    const read = (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes("service listening on")) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout?.on("data", read)
    child.stderr?.on("data", read)
  })
  const sockets = new Set<Socket>()
  const proxy = createServer((client) => {
    const upstream = connect(socketPath)
    for (const socket of [client, upstream]) {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
      socket.on("error", () => {
        client.destroy()
        upstream.destroy()
      })
    }
    client.pipe(upstream).pipe(client)
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const address = proxy.address()
  if (!address || typeof address === "string") {
    throw new Error("the S3 proxy has no TCP address")
  }
  const endpoint = `http://127.0.0.1:${address.port}`
  const keys = async () => {
    const dir = join(root, bucket)
    const names = await readdir(dir, { recursive: true, withFileTypes: true })
    return names
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
      .sort()
  }
  return {
    bucket,
    keys,
    stubEnv: (prefix) => {
      vi.stubEnv("CODESEARCH_SHARD_STORE", `s3://${bucket}/${prefix}`)
      vi.stubEnv("AWS_ENDPOINT_URL_S3", endpoint)
      vi.stubEnv("AWS_ACCESS_KEY_ID", accessKey)
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", secretKey)
      vi.stubEnv("AWS_REGION", "us-east-1")
    },
    stop: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => proxy.close(resolve))
      child.removeAllListeners("exit")
      child.kill()
      await rm(base, { recursive: true, force: true })
    },
  }
}
