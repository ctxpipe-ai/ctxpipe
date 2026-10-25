import { afterAll, describe, expect, it } from "vitest"

import { commitGitTree, removeGitTrees } from "../../test/git-tree.js"
import { listExistingBlobs } from "./existing-blobs.js"
import { gitBlobSha, stampMirrorFiles, stampSources } from "./stamp-sources.js"

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

  it("skips a Markdown blob over the size cap and still reads the next one", async () => {
    const huge = `---\nsource: slack\n---\n${"x".repeat(3 * 1024 * 1024)}\n`
    const dir = commitGitTree({
      "slack/channels/C1/a.md": page,
      "slack/channels/C1/b-huge.md": huge,
      "slack/channels/C1/c.md": page,
    })
    const blobs = await listExistingBlobs(dir, "HEAD", [
      { prefixes: ["slack/channels/C1/"], sourcePath: "sources/slack/c.md" },
    ])
    const byPath = Object.fromEntries(blobs.map((blob) => [blob.path, blob]))
    const restamped = stampSources(page, ["sources/slack/c.md"])
    expect(byPath["slack/channels/C1/b-huge.md"]).toEqual({
      path: "slack/channels/C1/b-huge.md",
      sha: gitBlobSha(huge),
    })
    expect(byPath["slack/channels/C1/a.md"]?.restamped).toBe(restamped)
    expect(byPath["slack/channels/C1/c.md"]?.restamped).toBe(restamped)
  })
})

describe("stampMirrorFiles (real git)", () => {
  it("stamps the new files and restamps the closed pull requests after a rename", async () => {
    const pull = (number: number) =>
      `---\nsource: github\nnumber: ${number}\n---\n# PR ${number}\n`
    const dir = commitGitTree({
      "github/pulls/acme/api/1--1.md": stampSources(pull(1), [
        "sources/github/acme/api.md",
      ]),
      "github/pulls/acme/api/2--2.md": pull(2),
      "github/pulls/acme/api/3--3.md": stampSources(pull(3), [
        "sources/github/team/api.md",
      ]),
    })
    const sourcePath = "sources/github/team/api.md"
    const existing = await listExistingBlobs(dir, "HEAD", [
      { prefixes: ["github/pulls/acme/api/"], sourcePath },
    ])
    const files = stampMirrorFiles(
      [
        { path: "github/pulls/acme/api/2--2.md", content: pull(2) },
        { path: "github/pulls/acme/api/4--4.md", content: pull(4) },
      ],
      sourcePath,
      existing,
    )
    expect(Object.fromEntries(files.map((f) => [f.path, f.content]))).toEqual({
      "github/pulls/acme/api/1--1.md": stampSources(pull(1), [sourcePath]),
      "github/pulls/acme/api/2--2.md": stampSources(pull(2), [sourcePath]),
      "github/pulls/acme/api/4--4.md": stampSources(pull(4), [sourcePath]),
    })
  })
})
