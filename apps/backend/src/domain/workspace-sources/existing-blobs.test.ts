import { afterAll, describe, expect, it } from "vitest"
import { commitGitTree, removeGitTrees } from "../../test/git-tree.js"
import { listExistingBlobs } from "./existing-blobs.js"
import { gitBlobSha, stampSources } from "./stamp-sources.js"

afterAll(removeGitTrees)

const page = "---\nsource: linear\n---\n# Page\n"

describe("listExistingBlobs (real git)", () => {
  it("gives the sha of the text without the stamp, and a new stamp where the list is wrong", async () => {
    const dir = commitGitTree({
      "linear/team/stamped.md": stampSources(page, ["sources/linear/team.md"]),
      "linear/team/old.md": stampSources(page, ["sources/linear/before.md"]),
      "linear/team/unstamped.md": page,
      "linear/team/plain.md": "# Plain\n",
      "linear/team/logo.png": "png",
      "linear/legacy/stamped.md": stampSources(page, ["sources/linear/x.md"]),
      "linear/other/note.md": page,
    })
    const blobs = await listExistingBlobs(dir, "HEAD", [
      { prefixes: ["linear/team/"], sourcePath: "sources/linear/team.md" },
      // A row of the YAML dual read: no stamp, but the sha is without one.
      { prefixes: ["linear/legacy/"], sourcePath: null },
    ])
    const restamped = stampSources(page, ["sources/linear/team.md"])
    expect(
      Object.fromEntries(blobs.map(({ path, ...blob }) => [path, blob])),
    ).toEqual({
      "linear/team/stamped.md": { sha: gitBlobSha(page) },
      "linear/team/old.md": { sha: gitBlobSha(page), restamped },
      "linear/team/unstamped.md": { sha: gitBlobSha(page), restamped },
      "linear/team/plain.md": { sha: gitBlobSha("# Plain\n") },
      "linear/team/logo.png": { sha: gitBlobSha("png") },
      "linear/legacy/stamped.md": { sha: gitBlobSha(page) },
    })
  })

  it("reads the paths under a Workspace root", async () => {
    const dir = commitGitTree({
      "space/linear/team/a.md": page,
      "linear/team/b.md": page,
    })
    const blobs = await listExistingBlobs(
      dir,
      "HEAD",
      [{ prefixes: ["linear/team/"], sourcePath: "sources/linear/team.md" }],
      "space/",
    )
    expect(blobs.map((blob) => blob.path)).toEqual(["linear/team/a.md"])
  })

  it("reads more Markdown than one Git output buffer holds", async () => {
    // One blob at 70 paths: `git cat-file --batch` prints 70 MiB, more than
    // the 64 MiB that a buffered Git call accepts.
    const big = `---\nsource: slack\n---\n${"x".repeat(1024 * 1024)}\n`
    const dir = commitGitTree(
      Object.fromEntries(
        Array.from({ length: 70 }, (_, index) => [
          `slack/channels/C1/${index}.md`,
          big,
        ]),
      ),
    )
    const blobs = await listExistingBlobs(dir, "HEAD", [
      { prefixes: ["slack/channels/C1/"], sourcePath: "sources/slack/c.md" },
    ])
    expect(blobs).toHaveLength(70)
    expect(blobs.every((blob) => blob.restamped !== undefined)).toBe(true)
  })
})
