import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { planPagerdutyLegacyMoves } from "./workspace-source-migration.js"

const run = promisify(execFile)

const incident = (serviceLine: string) =>
  `---\nsource: pagerduty\npagerduty_id: "PINC1"\nincident_number: 1\n${serviceLine}status: "resolved"\n---\n\n# Checkout is slow\n`

/** A Workspace repository that the old PagerDuty mirror wrote. */
const LEGACY = {
  "pagerduty/config.yaml": "version: 1\n",
  "pagerduty/incidents/1--PINC1.md": incident('service_id: "PSVC001"\n'),
  "pagerduty/incidents/1--PINC1/assets/PALERT1-image-0.png": "png bytes",
  "pagerduty/incidents/2--PINC2.md": incident('service_id: "PSVC002"\n'),
  "pagerduty/incidents/3--PINC3.md": incident(""),
  "pagerduty/incidents/4--PINC4.md": "No front matter\n",
}

describe("PagerDuty legacy incident moves (real git)", () => {
  let dir: string
  const git = async (...args: string[]) =>
    (await run("git", ["-C", dir, ...args])).stdout.trim()

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ctxpipe-pd-move-"))
    await run("git", ["init", "-b", "main", dir])
    await git("config", "user.email", "dev@example.com")
    await git("config", "user.name", "Dev")
    for (const [path, content] of Object.entries(LEGACY)) {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }
    await git("add", "-A")
    await git("commit", "-m", "Old mirror")
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("moves each incident with a service id into its service folder, and keeps its history", async () => {
    const files = (await git("ls-tree", "-r", "HEAD"))
      .split("\n")
      .map((line) => {
        const [meta, path] = line.split("\t")
        return { path: path ?? "", sha: meta?.split(" ")[2] ?? "" }
      })
    const reads: string[] = []

    const moves = await planPagerdutyLegacyMoves({
      files,
      read: async (path) => {
        reads.push(path)
        return git("show", `HEAD:${path}`)
      },
    })

    // Only the incident Markdown is read, never an asset.
    expect(reads.every((path) => path.endsWith(".md"))).toBe(true)
    expect(moves.map(({ from, to }) => [from, to])).toEqual([
      [
        "pagerduty/incidents/1--PINC1.md",
        "pagerduty/services/PSVC001/incidents/1--PINC1.md",
      ],
      [
        "pagerduty/incidents/1--PINC1/assets/PALERT1-image-0.png",
        "pagerduty/services/PSVC001/incidents/1--PINC1/assets/PALERT1-image-0.png",
      ],
      [
        "pagerduty/incidents/2--PINC2.md",
        "pagerduty/services/PSVC002/incidents/2--PINC2.md",
      ],
    ])

    // Write the moves as tree entries by blob sha, as the migration commit does.
    for (const move of moves) {
      await git(
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${move.sha},${move.to}`,
      )
      await git("rm", "--cached", "-q", move.from)
    }
    await git("commit", "-m", "Move connector sources")
    await git("checkout", "--", ".")

    expect(await git("diff", "-M", "--name-status", "HEAD~1", "HEAD")).toBe(
      [
        "R100\tpagerduty/incidents/1--PINC1.md\tpagerduty/services/PSVC001/incidents/1--PINC1.md",
        "R100\tpagerduty/incidents/1--PINC1/assets/PALERT1-image-0.png\tpagerduty/services/PSVC001/incidents/1--PINC1/assets/PALERT1-image-0.png",
        "R100\tpagerduty/incidents/2--PINC2.md\tpagerduty/services/PSVC002/incidents/2--PINC2.md",
      ].join("\n"),
    )
    expect(
      await git(
        "log",
        "--follow",
        "--format=%s",
        "--",
        "pagerduty/services/PSVC001/incidents/1--PINC1.md",
      ),
    ).toBe("Move connector sources\nOld mirror")
    // A file without a readable service id stays where it is.
    expect(await git("ls-files", "pagerduty/incidents")).toBe(
      "pagerduty/incidents/3--PINC3.md\npagerduty/incidents/4--PINC4.md",
    )
  })
})
