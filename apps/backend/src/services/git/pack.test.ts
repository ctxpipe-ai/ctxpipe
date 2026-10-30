import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { initLogger } from "evlog"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  captureGitPack,
  fetchGitCommits,
  type GitPack,
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
      withGitDirectory(
        "0".repeat(40),
        async (directory) => {
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
        },
        undefined,
        null,
      ),
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
    const pack = await captureGitPack(source, sha, null)
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
        null,
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
    withGitDirectory(
      sha,
      async () => undefined,
      {
        sha,
        objects: Buffer.from("PACK but not a pack").toString("base64"),
        shallow: "",
      },
      null,
    ),
  ).rejects.toThrow(/git index-pack exit code 128 after \d+ s: fatal: /)
})

/** A repository with one commit; the caller removes `directory`. */
async function seededRepository() {
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-base-source-"))
  await nativeGit(directory, ["init", "-q"])
  await writeFile(join(directory, "notes.md"), "# Notes\n")
  await nativeGit(directory, ["add", "-A"])
  await nativeGit(directory, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "seed",
  ])
  const sha = (await nativeGit(directory, ["rev-parse", "HEAD"]))
    .toString()
    .trim()
  return { directory, sha }
}

const boundUrl = "https://github.com/fixture/bound.git"

it.each([
  {
    name: "another repository, with the connection of another org",
    url: "https://github.com/other-owner/other-repo.git",
    readUrl: boundUrl,
    stored: { orgId: "org_other", connectionId: "con_other" },
  },
  {
    name: "another host",
    url: "https://git.example.invalid/fixture/bound.git",
    readUrl: "https://git.example.invalid/fixture/bound.git",
    stored: {},
  },
  {
    name: "plain HTTP",
    url: "http://github.com/fixture/bound.git",
    readUrl: "http://github.com/fixture/bound.git",
    stored: {},
  },
  {
    name: "a URL with a user name",
    url: "https://x@github.com/o/r",
    readUrl: "https://x@github.com/o/r",
    stored: {},
  },
  {
    name: "a host that only starts with github.com",
    url: "https://github.com.evil/o/r",
    readUrl: "https://github.com.evil/o/r",
    stored: {},
  },
  {
    name: "a URL with a port",
    url: "https://github.com:8443/o/r",
    readUrl: "https://github.com:8443/o/r",
    stored: {},
  },
  {
    name: "a URL with a backslash",
    url: "https://github.com\\@evil.example/o/r",
    readUrl: "https://github.com\\@evil.example/o/r",
    stored: {},
  },
])(
  "rejects a stored base on $name before it asks for a token (CTX-955)",
  async ({ url, readUrl, stored }) => {
    const sha = "a".repeat(40)
    const token = vi.fn(async () => "fixture-only-token")
    const pack = {
      sha,
      objects: "",
      shallow: "",
      base: { url, shas: [sha], ...stored },
    } as GitPack
    await expect(
      withGitDirectory(sha, async () => "opened", pack, {
        url: readUrl,
        token,
      }),
    ).rejects.toThrow("not the GitHub repository of its Workspace")
    expect(token).not.toHaveBeenCalled()
  },
)

it("fetches a stored base with the read access of the caller, not with the org and connection in the output (CTX-955)", async () => {
  const source = await seededRepository()
  const config = join(source.directory, "gitconfig")
  try {
    // The bound GitHub URL reads from the local repository.
    await writeFile(
      config,
      `[url "${source.directory}"]\n\tinsteadOf = ${boundUrl}\n`,
    )
    vi.stubEnv("GIT_CONFIG_GLOBAL", config)
    const token = vi.fn(async () => "fixture-only-token")
    const pack = {
      sha: source.sha,
      objects: "",
      shallow: "",
      base: {
        url: boundUrl,
        shas: [source.sha],
        orgId: "org_other",
        connectionId: "con_other",
      },
    } as GitPack
    const content = await withGitDirectory(
      source.sha,
      async (directory) =>
        (
          await nativeGit(directory, ["show", `${source.sha}:notes.md`])
        ).toString(),
      pack,
      { url: boundUrl, token },
    )
    expect(content).toBe("# Notes\n")
    expect(token).toHaveBeenCalledTimes(1)
    await expect(
      withGitDirectory(source.sha, async () => "opened", pack, null),
    ).rejects.toThrow("needs the read access of its Workspace")
  } finally {
    vi.unstubAllEnvs()
    await rm(source.directory, { recursive: true, force: true })
  }
})

it.each([
  { status: 503, attempts: 3, error: "returned error: 503" },
  { status: 404, attempts: 1, error: "not found" },
  { status: 403, attempts: 1, error: "returned error: 403" },
])(
  "fetches again after a $status answer only when the Git host can recover: $attempts attempts",
  async ({ status, attempts, error }) => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests++
      response.writeHead(status).end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("No port")
    const directory = await mkdtemp(join(tmpdir(), "ctxpipe-fetch-retry-"))
    try {
      await nativeGit(directory, ["init", "-q"])
      await expect(
        fetchGitCommits(directory, {
          url: `http://127.0.0.1:${address.port}/fixture/bound.git`,
          shas: ["a".repeat(40)],
        }),
      ).rejects.toThrow(error)
      expect(requests).toBe(attempts)
    } finally {
      server.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  30_000,
)

describe("Git answer exit codes are not failures (CTX-1089)", () => {
  afterEach(() => {
    initLogger({ enabled: false })
  })

  /** Drain evlog into an array while the test runs. */
  function captureEvents(): Record<string, unknown>[] {
    const events: Record<string, unknown>[] = []
    initLogger({
      pretty: false,
      silent: true,
      drain: (ctx) => {
        for (const item of Array.isArray(ctx) ? ctx : [ctx])
          events.push(item.event as Record<string, unknown>)
      },
    })
    return events
  }

  /** A commit that replaces `f.txt` with `content`; returns its SHA. */
  async function commitFile(
    directory: string,
    content: string,
  ): Promise<string> {
    await writeFile(join(directory, "f.txt"), content)
    await nativeGit(directory, ["add", "-A"])
    await nativeGit(directory, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "-m",
      content,
    ])
    return (await nativeGit(directory, ["rev-parse", "HEAD"])).toString().trim()
  }

  it("merge-base --is-ancestor answers no with exit code 1 and logs no failure", async () => {
    const events = captureEvents()
    const directory = await mkdtemp(join(tmpdir(), "ctxpipe-git-answer-"))
    try {
      await nativeGit(directory, ["init", "-q"])
      const a = await commitFile(directory, "a")
      const b = await commitFile(directory, "b")

      await expect(
        nativeGit(directory, ["merge-base", "--is-ancestor", b, a]),
      ).rejects.toHaveProperty("code", 1)
      expect(
        events.filter((event) => event.step === "git.command_failed"),
      ).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("merge-tree answers a conflict with exit code 1 and logs no failure", async () => {
    const events = captureEvents()
    const directory = await mkdtemp(join(tmpdir(), "ctxpipe-git-answer-"))
    try {
      await nativeGit(directory, ["init", "-q"])
      const x = await commitFile(directory, "base")
      const y = await commitFile(directory, "one")
      await nativeGit(directory, ["checkout", "-q", "--detach", x])
      const z = await commitFile(directory, "two")

      await expect(
        nativeGit(directory, [
          "merge-tree",
          "--write-tree",
          "--name-only",
          "-z",
          `--merge-base=${x}`,
          y,
          z,
        ]),
      ).rejects.toHaveProperty("code", 1)
      expect(
        events.filter((event) => event.step === "git.command_failed"),
      ).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("a real merge-base failure still logs", async () => {
    const events = captureEvents()
    const directory = await mkdtemp(join(tmpdir(), "ctxpipe-git-answer-"))
    try {
      await nativeGit(directory, ["init", "-q"])
      const a = await commitFile(directory, "a")

      await expect(
        nativeGit(directory, [
          "merge-base",
          "--is-ancestor",
          "0".repeat(40),
          a,
        ]),
      ).rejects.toHaveProperty("code", 128)
      expect(events.some((event) => event.step === "git.command_failed")).toBe(
        true,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
