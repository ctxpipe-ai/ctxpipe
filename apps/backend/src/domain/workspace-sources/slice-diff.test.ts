import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { diffSlice } from "./slice-diff.js"

const execFileAsync = promisify(execFile)
let dir: string | undefined

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function blobId(content: string): Promise<string> {
  dir ??= await mkdtemp(join(tmpdir(), "ctxpipe-slice-"))
  const file = join(dir, "blob")
  await writeFile(file, content)
  return (await execFileAsync("git", ["hash-object", file])).stdout.trim()
}

describe("diffSlice", () => {
  it("keeps changed files and deletes stale files under the owned prefixes only", async () => {
    const blobs = [
      { path: "confluence/ENG/home.md", sha: await blobId("# ENG\n") },
      { path: "confluence/ENG/old.md", sha: await blobId("old\n") },
      { path: "confluence/HR/policy.md", sha: await blobId("# HR\n") },
      { path: "notes/user.md", sha: await blobId("mine\n") },
    ]
    expect(
      diffSlice(
        {
          ownedPrefixes: ["confluence/ENG/"],
          files: [
            { path: "confluence/ENG/home.md", content: "# ENG\n" },
            { path: "confluence/ENG/new.md", content: "new\n" },
          ],
        },
        blobs,
      ),
    ).toEqual({
      files: [{ path: "confluence/ENG/new.md", content: "new\n" }],
      deletePaths: ["confluence/ENG/old.md"],
    })
  })
})
