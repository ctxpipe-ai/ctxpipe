import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { readSliceTarget } from "./slice-target.js"

const git = promisify(execFile)
let dir: string

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function commit(files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  await git("git", ["-C", dir, "add", "-A"])
  await git("git", ["-C", dir, "commit", "-m", "change"])
  return (await git("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim()
}

describe("readSliceTarget", () => {
  it("is fresh only while the head has the sources file of the rows' revision", async () => {
    dir = await mkdtemp(join(tmpdir(), "ctxpipe-slice-target-"))
    await git("git", ["init", "-b", "main", dir])
    await git("git", ["-C", dir, "config", "user.email", "dev@example.com"])
    await git("git", ["-C", dir, "config", "user.name", "Dev"])
    const rows = await commit({
      ".ctxpipe/sources.yaml": "version: 1\nsources: []\n",
      "confluence/ENG/home.md": "# ENG\n",
    })
    const unrelated = await commit({ "notes.md": "hello\n" })
    const fresh = await readSliceTarget({
      url: dir,
      headSha: unrelated,
      rowsRevision: rows,
    })
    expect(fresh.fresh).toBe(true)
    expect(fresh.paths).toContain("confluence/ENG/home.md")
    expect(fresh.sourcesBlobSha).toMatch(/^[0-9a-f]{40}$/)

    const changed = await commit({
      ".ctxpipe/sources.yaml": "version: 1\nsources: [{id: x}]\n",
    })
    expect(
      (
        await readSliceTarget({
          url: dir,
          headSha: changed,
          rowsRevision: rows,
        })
      ).fresh,
    ).toBe(false)
  })
  it("fences a cleanup on its removed targets, not on the whole sources file", async () => {
    dir = await mkdtemp(join(tmpdir(), "ctxpipe-slice-target-"))
    await git("git", ["init", "-b", "main", dir])
    await git("git", ["-C", dir, "config", "user.email", "dev@example.com"])
    await git("git", ["-C", dir, "config", "user.name", "Dev"])
    const entry = (id: string, team: string) =>
      `  - {id: ${id}, provider: linear, connection: con_a, teams: [${team}]}\n`
    const removed = [
      { provider: "linear", connectionId: "con_a", scope: { teams: ["ENG"] } },
    ]
    const withoutX = await commit({
      ".ctxpipe/sources.yaml": `version: 1\nsources:\n${entry("y", "OPS")}`,
      "linear/teams/ENG/README.md": "# ENG\n",
    })
    const edited = await commit({
      ".ctxpipe/sources.yaml": `version: 1\nsources:\n${entry("y", "OPS")}${entry("z", "WEB")}`,
    })
    const target = await readSliceTarget({
      url: dir,
      headSha: edited,
      rowsRevision: withoutX,
      removed,
    })
    expect(target.fresh).toBe(true)

    // Not absent: the target is back, an entry id cannot be read, or the
    // file cannot be read.
    for (const text of [
      `version: 1\nsources:\n${entry("x", "ENG")}`,
      "version: 1\nsources: [{provider: linear}]\n",
      "version: [\n",
    ]) {
      const head = await commit({ ".ctxpipe/sources.yaml": text })
      const stale = await readSliceTarget({
        url: dir,
        headSha: head,
        rowsRevision: withoutX,
        removed,
      })
      expect(stale.fresh, text).toBe(false)
    }
  })

  it("reads the sources file and the paths below the Workspace root folder", async () => {
    dir = await mkdtemp(join(tmpdir(), "ctxpipe-slice-target-"))
    await git("git", ["init", "-b", "main", dir])
    await git("git", ["-C", dir, "config", "user.email", "dev@example.com"])
    await git("git", ["-C", dir, "config", "user.name", "Dev"])
    const rows = await commit({
      ".ctxpipe/sources.yaml": "version: 1\nsources: [{id: outside}]\n",
      "docs/context/.ctxpipe/sources.yaml": "version: 1\nsources: []\n",
      "docs/context/confluence/ENG/home.md": "# ENG\n",
      "src/app.ts": "export {}\n",
    })
    const outsideOnly = await commit({
      ".ctxpipe/sources.yaml": "version: 1\nsources: [{id: other}]\n",
    })
    const target = await readSliceTarget({
      url: dir,
      headSha: outsideOnly,
      rowsRevision: rows,
      root: "docs/context",
    })
    expect(target.fresh).toBe(true)
    expect(target.paths.sort()).toEqual([
      ".ctxpipe/sources.yaml",
      "confluence/ENG/home.md",
    ])
  })
})
