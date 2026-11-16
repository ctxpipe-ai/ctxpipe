import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { runScipIndexer } from "./scipIndexers.js"

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const exists = async (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-native-scip-"))
  const checkoutPath = join(directory, "checkout")
  const bin = join(directory, "bin")
  await mkdir(checkoutPath)
  await mkdir(bin)
  const env = { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` }
  return {
    directory,
    checkoutPath,
    env,
    async command(name: string, body: string) {
      const file = join(bin, name)
      await writeFile(file, `#!/bin/sh\nset -eu\n${body}\n`)
      await chmod(file, 0o755)
    },
    shard: (name: string) => join(directory, "shards", `${name}.scip`),
    release: () => writeFile(join(directory, "release"), "release"),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

it(
  "runs one native SCIP indexer at a time, each into its own shard",
  { timeout: 30_000 },
  async () => {
    const f = await fixture()
    const runs: Promise<unknown>[] = []
    try {
      // TypeScript runs per discovered project and merges shards, so this
      // slot test uses single-process direct-output indexers.
      for (const [command, name] of [
        ["scip-go", "go"],
        ["scip-python", "python"],
        ["scip-ruby", "ruby"],
      ] as const) {
        await f.command(
          command,
          `for output do :; done
printf '%s' ${quote(name)} > "$output"
touch ${quote(join(f.directory, `${name}.started`))}
while [ ! -f ${quote(join(f.directory, "release"))} ] && [ ! -f ${quote(join(f.directory, `release-${name}`))} ]; do sleep 0.01; done`,
        )
      }
      for (const indexerId of ["go", "python", "ruby"] as const)
        runs.push(
          runScipIndexer({
            indexerId,
            checkoutPath: f.checkoutPath,
            shardPath: f.shard(indexerId),
            env: f.env,
          }),
        )
      const started = async () =>
        (await readdir(f.directory))
          .filter((name) => name.endsWith(".started"))
          .map((name) => name.slice(0, -".started".length))
      const released: string[] = []
      for (const count of [1, 2, 3]) {
        await expect
          .poll(async () => (await started()).length, { timeout: 5_000 })
          .toBe(count)
        // The running indexer has no free slot to share.
        await new Promise((resolve) => setTimeout(resolve, 100))
        const running = (await started()).filter(
          (name) => !released.includes(name),
        )
        expect(running).toHaveLength(1)
        released.push(running[0] as string)
        await writeFile(join(f.directory, `release-${running[0]}`), "release")
      }
      await Promise.all(runs)
      expect(await exists(join(f.checkoutPath, "index.scip"))).toBe(false)
      for (const name of ["go", "python", "ruby"])
        expect(await readFile(f.shard(name), "utf8")).toBe(name)
    } finally {
      await f.release()
      await Promise.allSettled(runs)
      await f.cleanup()
    }
  },
)

it(
  "serializes native default-output indexers and publishes only after exit",
  { timeout: 30_000 },
  async () => {
    const f = await fixture()
    const runs: Promise<unknown>[] = []
    try {
      await writeFile(join(f.checkoutPath, "index.scip"), "stale")
      await f.command(
        "scip-php",
        `test ! -e index.scip
printf 'native shard' > index.scip
touch ${quote(f.directory)}/"$$.started"
while [ ! -f ${quote(join(f.directory, "release"))} ] && [ ! -f ${quote(f.directory)}/"release-$$" ]; do sleep 0.01; done`,
      )
      for (const name of ["first", "second"])
        runs.push(
          runScipIndexer({
            indexerId: "php",
            checkoutPath: f.checkoutPath,
            shardPath: f.shard(name),
            env: f.env,
          }),
        )
      const started = async () =>
        (await readdir(f.directory)).filter((name) => name.endsWith(".started"))
      await expect
        .poll(async () => (await started()).length, { timeout: 5_000 })
        .toBe(1)
      expect(await exists(f.shard("first"))).toBe(false)
      expect(await exists(f.shard("second"))).toBe(false)
      const [first] = await started()
      if (!first) throw new Error("Missing native process receipt")
      await writeFile(
        join(f.directory, `release-${first.slice(0, -".started".length)}`),
        "release",
      )
      await expect
        .poll(async () => (await started()).length, { timeout: 5_000 })
        .toBe(2)
      const published = await Promise.all([
        exists(f.shard("first")),
        exists(f.shard("second")),
      ])
      expect(published.filter(Boolean)).toHaveLength(1)
      await f.release()
      await Promise.all(runs)
      expect(await readFile(f.shard("first"), "utf8")).toBe("native shard")
      expect(await readFile(f.shard("second"), "utf8")).toBe("native shard")
      expect(await exists(join(f.checkoutPath, "index.scip"))).toBe(false)
    } finally {
      await f.release()
      await Promise.allSettled(runs)
      await f.cleanup()
    }
  },
)

it.each([
  {
    name: "SIGKILL",
    command: "kill -KILL $$",
    message: "Codebase didn't fit available memory",
    absent: true,
  },
  {
    name: "empty shard",
    command: 'for output do :; done\n: > "$output"',
    message: "produced an empty shard",
    absent: true,
  },
  {
    name: "non-file shard",
    command: 'for output do :; done\nmkdir "$output"',
    message: "it is not a regular file",
    absent: false,
  },
])(
  "rejects $name from a native third-party indexer",
  { timeout: 30_000 },
  async ({ command, message, absent }) => {
    const f = await fixture()
    try {
      await f.command("scip-go", command)
      await expect(
        runScipIndexer({
          indexerId: "go",
          checkoutPath: f.checkoutPath,
          shardPath: f.shard("go"),
          env: f.env,
        }),
      ).rejects.toThrow(message)
      if (absent) expect(await exists(f.shard("go"))).toBe(false)
    } finally {
      await f.cleanup()
    }
  },
)
