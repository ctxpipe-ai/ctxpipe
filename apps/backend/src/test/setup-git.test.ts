import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, expect, it } from "vitest"

const run = promisify(execFile)
let dir: string | undefined

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

// A detached `git maintenance run --auto` after a commit repacked the
// temporary repository while the test removed it (ENOTEMPTY, CTX-1497).
it("a git commit of a test starts no background maintenance", async () => {
  dir = await mkdtemp(join(tmpdir(), "ctxpipe-setup-git-"))
  const trace = join(dir, "trace2.txt")
  await run("git", ["init", "-b", "main", join(dir, "repo")])
  await writeFile(join(dir, "repo", "a.md"), "# A\n")
  await run("git", ["-C", join(dir, "repo"), "add", "-A"])
  await run(
    "git",
    [
      "-C",
      join(dir, "repo"),
      "-c",
      "user.email=dev@example.com",
      "-c",
      "user.name=Dev",
      "commit",
      "-m",
      "change",
    ],
    { env: { ...process.env, GIT_TRACE2: trace } },
  )

  // The commit writes a child_start line for each process that it starts.
  const children = (await readFile(trace, "utf8"))
    .split("\n")
    .filter((line) => line.includes("child_start"))
  expect(children.filter((line) => /\b(maintenance|gc)\b/.test(line))).toEqual(
    [],
  )
})
