import { execFile } from "node:child_process"
import { createReadStream } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"
import { gitRemoteEnvironment } from "./clone-tree.js"

const execute = promisify(execFile)

/** Native pack and shallow boundary; no filesystem locator or credential is durable. */
export type GitPack = { sha: string; objects: string; shallow: string }

export async function nativeGit(
  directory: string,
  args: string[],
  input?: Uint8Array | string | { file: string },
  env?: NodeJS.ProcessEnv,
): Promise<Buffer> {
  const result = execute(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-C", directory, ...args],
    {
      encoding: "buffer",
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      env: env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  )
  if (typeof input === "object" && "file" in input) {
    const stdin = result.child.stdin
    if (!stdin) throw new Error("Native Git did not expose standard input")
    const streamed = pipeline(createReadStream(input.file), stdin).catch(
      (error) => {
        result.child.kill()
        throw error
      },
    )
    return (await Promise.all([result, streamed]))[0].stdout
  }
  if (input !== undefined) result.child.stdin?.end(input)
  return (await result).stdout
}

export async function captureGitPack(
  directory: string,
  sha: string,
  additionalShas: readonly string[] = [],
): Promise<GitPack> {
  const objects = await nativeGit(
    directory,
    ["pack-objects", "--stdout", "--revs"],
    `${[sha, ...additionalShas].join("\n")}\n`,
  )
  const shallow = await readFile(join(directory, ".git/shallow"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    },
  )
  return { sha, objects: objects.toString("base64"), shallow }
}

export async function withGitDirectory<T>(
  sha: string,
  operation: (directory: string) => Promise<T>,
  pack?: GitPack,
): Promise<T> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha))
    throw new Error("An immutable full Git SHA is required")
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-write-step-"))
  try {
    await nativeGit(directory, [
      "init",
      "--template=",
      `--object-format=${sha.length === 64 ? "sha256" : "sha1"}`,
    ])
    if (pack) {
      if (pack.sha !== sha) throw new Error("Git pack identity mismatch")
      await nativeGit(
        directory,
        ["index-pack", "--stdin"],
        Buffer.from(pack.objects, "base64"),
      )
      if (pack.shallow)
        await writeFile(join(directory, ".git/shallow"), pack.shallow)
      await nativeGit(directory, ["checkout", "--detach", sha])
    }
    return await operation(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Read selected immutable blobs; the workflow owns the surrounding durable step. */
export async function readGitFiles(
  pack: GitPack,
  include: (path: string) => boolean,
): Promise<Array<{ path: string; content: string }>> {
  return withGitDirectory(
    pack.sha,
    async (directory) => {
      const paths = (
        await nativeGit(directory, [
          "ls-tree",
          "-r",
          "--name-only",
          "-z",
          pack.sha,
        ])
      )
        .toString()
        .split("\0")
        .filter((path) => path && include(path))
      const files: Array<{ path: string; content: string }> = []
      for (const path of paths)
        files.push({
          path,
          content: (
            await nativeGit(directory, ["show", `${pack.sha}:${path}`])
          ).toString(),
        })
      return files
    },
    pack,
  )
}

/** Capture immutable remote trees with a transient caller-owned read credential. */
export async function readGitPackFromRemote(input: {
  url: string
  sha: string
  additionalShas?: readonly string[]
  token?: string
}): Promise<GitPack> {
  return withGitDirectory(input.sha, async (directory) => {
    await nativeGit(
      directory,
      [
        "fetch",
        "--depth",
        "1",
        "--",
        input.url,
        input.sha,
        ...(input.additionalShas ?? []),
      ],
      undefined,
      gitRemoteEnvironment({ url: input.url, token: input.token }),
    )
    return captureGitPack(directory, input.sha, input.additionalShas)
  })
}
