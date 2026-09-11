import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
  "runs native direct-output indexers concurrently with separate shard contents",
  { timeout: 30_000 },
  async () => {
    const f = await fixture()
    const runs: Promise<void>[] = []
    try {
      for (const [command, name] of [
        ["scip-go", "go"],
        ["scip-typescript", "typescript"],
      ] as const) {
        await f.command(
          command,
          `for output do :; done
printf '%s' ${quote(name)} > "$output"
touch ${quote(join(f.directory, `${name}.started`))}
while [ ! -f ${quote(join(f.directory, "release"))} ]; do sleep 0.01; done`,
        )
      }
      for (const indexerId of ["go", "typescript"] as const)
        runs.push(
          runScipIndexer({
            indexerId,
            checkoutPath: f.checkoutPath,
            shardPath: f.shard(indexerId),
            env: f.env,
          }),
        )
      await expect
        .poll(
          async () =>
            (await exists(join(f.directory, "go.started"))) &&
            (await exists(join(f.directory, "typescript.started"))),
        )
        .toBe(true)
      expect(await exists(join(f.checkoutPath, "index.scip"))).toBe(false)
      await f.release()
      await Promise.all(runs)
      expect(await readFile(f.shard("go"), "utf8")).toBe("go")
      expect(await readFile(f.shard("typescript"), "utf8")).toBe("typescript")
    } finally {
      await f.release()
      await Promise.allSettled(runs)
      await f.cleanup()
    }
  },
)

it(
  "admits at most two native indexer processes and releases a slot after exit",
  { timeout: 30_000 },
  async () => {
    const f = await fixture()
    const runs: Promise<void>[] = []
    try {
      for (const [command, name] of [
        ["scip-go", "go"],
        ["scip-typescript", "typescript"],
        ["scip-python", "python"],
      ] as const) {
        await f.command(
          command,
          `for output do :; done
printf '%s' ${quote(name)} > "$output"
touch ${quote(join(f.directory, `${name}.started`))}
while [ ! -f ${quote(join(f.directory, "release"))} ] && [ ! -f ${quote(join(f.directory, `release-${name}`))} ]; do sleep 0.01; done`,
        )
      }
      for (const indexerId of ["go", "typescript", "python"] as const)
        runs.push(
          runScipIndexer({
            indexerId,
            checkoutPath: f.checkoutPath,
            shardPath: f.shard(indexerId),
            env: f.env,
          }),
        )
      const started = async () =>
        (await readdir(f.directory)).filter((name) => name.endsWith(".started"))
      await expect
        .poll(async () => (await started()).length, { timeout: 5_000 })
        .toBe(2)
      const [first] = await started()
      if (!first) throw new Error("Missing native process receipt")
      await writeFile(
        join(f.directory, `release-${first.slice(0, -".started".length)}`),
        "release",
      )
      await expect
        .poll(async () => (await started()).length, { timeout: 5_000 })
        .toBe(3)
      await f.release()
      await Promise.all(runs)
      for (const name of ["go", "typescript", "python"])
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
    const runs: Promise<void>[] = []
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
