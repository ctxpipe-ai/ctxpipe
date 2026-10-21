import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import {
  captureGitPack,
  listTreeBlobs,
  nativeGit,
  withGitDirectory,
} from "./pack.js"

it("lists every blob with its object id, including unusual paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-tree-blobs-"))
  try {
    await nativeGit(directory, ["init", "-q"])
    await mkdir(join(directory, "linear", "issues", "eng-1", "assets"), {
      recursive: true,
    })
    await writeFile(join(directory, "linear", "issues", "eng-1.md"), "issue")
    await writeFile(
      join(directory, "linear", "issues", "eng-1", "assets", "a b\tc.png"),
      Buffer.from([0, 1, 2]),
    )
    await nativeGit(directory, ["add", "-A"])
    await nativeGit(directory, [
      "-c",
      "user.name=ctxpipe",
      "-c",
      "user.email=ctxpipe@example.invalid",
      "commit",
      "-q",
      "-m",
      "seed",
    ])
    const expected = await Promise.all(
      ["linear/issues/eng-1.md", "linear/issues/eng-1/assets/a b\tc.png"].map(
        async (path) => ({
          path,
          sha: (await nativeGit(directory, ["rev-parse", `HEAD:${path}`]))
            .toString()
            .trim(),
        }),
      ),
    )

    expect(
      (await listTreeBlobs(directory, "HEAD")).sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
    ).toEqual(expected.sort((a, b) => a.path.localeCompare(b.path)))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("follows Git's exit status when Git stops before it reads all of a file input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-native-stdin-"))
  try {
    await nativeGit(directory, ["init", "-q"])
    // Larger than any pipe buffer, so Git exits while the write is still open.
    const input = join(directory, "input.bin")
    await writeFile(input, Buffer.alloc(16 * 1024 * 1024, "x"))

    // `rev-parse` never reads standard input and succeeds.
    await expect(
      nativeGit(directory, ["rev-parse", "--git-dir"], { file: input }),
    ).resolves.toEqual(Buffer.from(".git\n"))
    // `index-pack` reads only the header, then fails with its own error.
    await expect(
      nativeGit(directory, ["index-pack", "--stdin"], { file: input }),
    ).rejects.toThrow(/fatal: .*pack signature mismatch/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("keeps a read error on the file input fatal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-native-stdin-"))
  try {
    await nativeGit(directory, ["init", "-q"])
    await expect(
      nativeGit(directory, ["hash-object", "--stdin"], {
        file: join(directory, "missing.bin"),
      }),
    ).rejects.toThrow(/ENOENT/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("waits for a Git process the operation left running before it removes the directory", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "ctxpipe-left-running-"))
  const fifo = join(scratch, "input")
  await new Promise<void>((resolve, reject) =>
    execFile("mkfifo", [fifo], (error) => (error ? reject(error) : resolve())),
  )
  let leftSettled = false
  let leftError: unknown
  let leftDirectory = ""
  try {
    await expect(
      withGitDirectory("0".repeat(40), async (directory) => {
        leftDirectory = directory
        // Git blocks on the pipe: it is alive until something writes to it or kills it.
        void nativeGit(directory, ["hash-object", "-w", "--stdin"], {
          file: fifo,
        })
          .catch((error: unknown) => {
            leftError = error
          })
          .finally(() => {
            leftSettled = true
          })
        // Let Git start and block, so the process is really alive.
        await new Promise((resolve) => setTimeout(resolve, 200))
        throw new Error("the operation failed")
      }),
    ).rejects.toThrow("the operation failed")
    // The clean-up has waited: the process has exited, not only been signaled.
    expect(leftSettled).toBe(true)
    // The error names the signal; the kill gave Git no time to write stderr.
    expect(String(leftError)).toMatch(
      /git hash-object stopped by SIGTERM after \d+ s with no error output/,
    )
    await expect(open(leftDirectory)).rejects.toThrow(/ENOENT/)
  } finally {
    // Release the blocked read of the pipe, then remove it.
    await open(fifo, "r+")
      .then((handle) => handle.close())
      .catch(() => undefined)
    await rm(scratch, { recursive: true, force: true })
  }
})

it("opens a large pack without the whole pack in memory", async () => {
  const source = await mkdtemp(join(tmpdir(), "ctxpipe-large-pack-"))
  try {
    await nativeGit(source, ["init", "-q"])
    // Random content does not compress: the pack is about 48 MiB.
    for (let folder = 0; folder < 12; folder++) {
      await mkdir(join(source, `knowledge/${folder}`), { recursive: true })
      for (let file = 0; file < 64; file++)
        await writeFile(
          join(source, `knowledge/${folder}/${file}.md`),
          randomBytes(64 * 1024).toString("hex"),
        )
    }
    await nativeGit(source, ["add", "-A"])
    await nativeGit(source, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "large",
    ])
    const sha = (await nativeGit(source, ["rev-parse", "HEAD"]))
      .toString()
      .trim()
    const pack = await captureGitPack(source, sha)
    const packBytes = (pack.objects.length * 3) / 4
    expect(packBytes).toBeGreaterThan(40 * 2 ** 20)

    // A Buffer of the whole decoded pack shows in `arrayBuffers`.
    const baseline = process.memoryUsage().arrayBuffers
    let peak = baseline
    const sample = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers)
    }, 1)
    try {
      const count = await withGitDirectory(
        sha,
        async (directory) =>
          (await nativeGit(directory, ["ls-tree", "-r", "--name-only", "HEAD"]))
            .toString()
            .trim()
            .split("\n").length,
        pack,
      )
      expect(count).toBe(12 * 64)
    } finally {
      clearInterval(sample)
    }
    expect(peak - baseline).toBeLessThan(packBytes / 4)
  } finally {
    await rm(source, { recursive: true, force: true })
  }
}, 120_000)

it("puts the Git error output and the exit code in the error of a failed pack", async () => {
  const sha = "a".repeat(40)
  await expect(
    withGitDirectory(sha, async () => undefined, {
      sha,
      objects: Buffer.from("PACK but not a pack").toString("base64"),
      shallow: "",
    }),
  ).rejects.toThrow(/git index-pack exit code 128 after \d+ s: fatal: /)
})
