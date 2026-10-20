import { execFile } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it, vi } from "vitest"
import { gitOutput } from "./clone-tree.js"
import { nativeGit } from "./pack.js"
import { isTemporarySpawnError, withGitProcessSlot } from "./process-slot.js"

const execFileAsync = promisify(execFile)

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

/** The error that Node gives when the operating system refuses a process. */
function refusedSpawn(code: string) {
  return Object.assign(new Error(`spawn git ${code}`), {
    code,
    errno: -35,
    syscall: "spawn git",
  })
}

it("never runs more than eight Git processes at one time", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "ctxpipe-git-slot-"))
  try {
    const realGit = (
      await execFileAsync("sh", ["-c", "command -v git"])
    ).stdout.trim()
    // A `git` before the real one on PATH: each process records the number
    // of live processes when it starts, and it stays a short time.
    const bin = join(scratch, "bin")
    const live = join(scratch, "live")
    const log = join(scratch, "log")
    await mkdir(bin)
    await mkdir(live)
    await writeFile(
      join(bin, "git"),
      [
        "#!/bin/sh",
        `mkdir "${live}/$$"`,
        `ls "${live}" | wc -l >> "${log}"`,
        "sleep 0.05",
        `"${realGit}" "$@"`,
        "status=$?",
        `rmdir "${live}/$$"`,
        "exit $status",
      ].join("\n"),
    )
    await chmod(join(bin, "git"), 0o755)
    const repository = join(scratch, "repository")
    await mkdir(repository)
    await execFileAsync(realGit, ["init", "-q", repository])
    for (let index = 0; index < 20; index++)
      await writeFile(join(repository, `${index}.md`), `file ${index}`)
    await execFileAsync(realGit, ["-C", repository, "add", "-A"])
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`)

    // Like an upgrade step: one read for each file, all at one time.
    const reads = await Promise.all(
      Array.from({ length: 20 }, (_, index) => [
        nativeGit(repository, ["cat-file", "blob", `:${index}.md`]),
        gitOutput(
          ["-C", repository, "cat-file", "blob", `:${index}.md`],
          60_000,
        ),
      ]).flat(),
    )

    expect(reads.map((read) => read.toString())).toEqual(
      Array.from({ length: 20 }, (_, index) => [
        `file ${index}`,
        `file ${index}`,
      ]).flat(),
    )
    const counts = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map(Number)
    expect(counts).toHaveLength(40)
    expect(Math.max(...counts)).toBeGreaterThan(1)
    expect(Math.max(...counts)).toBeLessThanOrEqual(8)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

it("starts Git again when the operating system refuses the process for a short time", async () => {
  let starts = 0
  const version = await withGitProcessSlot(async () => {
    starts++
    if (starts === 1) throw refusedSpawn("EAGAIN")
    return (await execFileAsync("git", ["--version"])).stdout
  })

  expect(starts).toBe(2)
  expect(version).toMatch(/^git version /)
})

it("gives the refusal to the caller after the last start", async () => {
  vi.useFakeTimers()
  let starts = 0
  const run = withGitProcessSlot(async () => {
    starts++
    throw refusedSpawn("ENOMEM")
  })
  const outcome = expect(run).rejects.toThrow("spawn git ENOMEM")
  await vi.advanceTimersByTimeAsync(250 + 1000 + 4000)
  await outcome
  expect(starts).toBe(4)
})

it("does not start Git again for a failure of the command", async () => {
  let starts = 0
  await expect(
    withGitProcessSlot(async () => {
      starts++
      await execFileAsync("git", ["no-such-command"])
    }),
  ).rejects.toThrow()
  expect(starts).toBe(1)
})

it.each([
  [refusedSpawn("EAGAIN"), true],
  [refusedSpawn("EMFILE"), true],
  [
    Object.assign(new Error("open EMFILE"), {
      code: "EMFILE",
      syscall: "open",
    }),
    false,
  ],
  [
    Object.assign(new Error("spawn git ENOENT"), {
      code: "ENOENT",
      syscall: "spawn git",
    }),
    false,
  ],
])("knows a temporary refusal of a process start: %s", (error, temporary) => {
  expect(isTemporarySpawnError(error)).toBe(temporary)
})
