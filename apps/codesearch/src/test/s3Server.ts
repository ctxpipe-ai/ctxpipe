import { type ChildProcess, spawn } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { vi } from "vitest"

/**
 * A real S3-compatible server for tests: `rclone serve s3` on a temporary
 * directory (the Docker test image has the pinned rclone binary). Each
 * bucket is a directory under `root`, and each object is a file.
 */
export async function startS3Server(): Promise<{
  bucket: string
  /** Every object key in the bucket, sorted. */
  keys: () => Promise<string[]>
  /** Points `CODESEARCH_SHARD_STORE` and the AWS SDK at this server. */
  stubEnv: (prefix: string) => void
  stop: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), "s3-server-"))
  const bucket = "codesearch-test"
  await mkdir(join(root, bucket))
  // rclone refuses access keys that are too short.
  const accessKey = "codesearchtestaccess"
  const secretKey = "codesearchtestsecret"
  const child: ChildProcess = spawn(
    "rclone",
    [
      "serve",
      "s3",
      root,
      "--addr",
      "127.0.0.1:0",
      "--auth-key",
      `${accessKey},${secretKey}`,
      "--config",
      "/dev/null",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  )
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = ""
    const timer = setTimeout(
      () => reject(new Error(`rclone did not start: ${output}`)),
      10_000,
    )
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
      const match = /Starting s3 server on \[(http:\/\/[^/\]]+)/.exec(output)
      if (match?.[1]) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
  })
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
      child.kill()
      await rm(root, { recursive: true, force: true })
    },
  }
}
