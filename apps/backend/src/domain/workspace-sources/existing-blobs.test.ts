import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { listExistingBlobs } from "./existing-blobs.js"
import { gitBlobSha, stampSources } from "./stamp-sources.js"

const dir = mkdtempSync(join(tmpdir(), "existing-blobs-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const git = (...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })

describe("listExistingBlobs (real git)", () => {
  it("reads the sources list of Markdown files under the root", async () => {
    const page = "---\nsource: linear\n---\n# Page\n"
    git("init", "-q")
    mkdirSync(join(dir, "linear"))
    mkdirSync(join(dir, "other"))
    writeFileSync(
      join(dir, "linear/stamped.md"),
      stampSources(page, ["sources/linear/team.md"]),
    )
    writeFileSync(join(dir, "linear/plain.md"), page)
    writeFileSync(join(dir, "linear/logo.png"), "png")
    writeFileSync(join(dir, "other/note.md"), page)
    git("add", ".")
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-qm",
      "x",
    )
    const blobs = await listExistingBlobs(dir, "HEAD", "linear/")
    const byPath = new Map(blobs.map((blob) => [blob.path, blob]))
    expect(byPath.get("linear/stamped.md")).toMatchObject({
      sources: ["sources/linear/team.md"],
      unstampedSha: gitBlobSha(page),
    })
    expect(byPath.get("linear/plain.md")).toMatchObject({ sources: null })
    expect(byPath.get("linear/plain.md")?.unstampedSha).toBeUndefined()
    expect(byPath.get("linear/logo.png")?.sources).toBeUndefined()
    expect(byPath.get("other/note.md")?.sources).toBeUndefined()
  })
})
