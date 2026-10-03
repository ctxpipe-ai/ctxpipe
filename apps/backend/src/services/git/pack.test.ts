import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { listTreeBlobs, nativeGit } from "./pack.js"

it("lists every blob with its object id, including unusual paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-tree-blobs-"))
  try {
    await nativeGit(directory, ["init", "-q"])
    await mkdir(join(directory, "linear", "issues", "eng-1", "assets"), {
      recursive: true,
    })
    await writeFile(join(directory, "linear", "issues", "eng-1.md"), "issue")
    await writeFile(
      join(directory, "linear", "issues", "eng-1", "assets", "a b\tc.png"),
      Buffer.from([0, 1, 2]),
    )
    await nativeGit(directory, ["add", "-A"])
    await nativeGit(directory, [
      "-c",
      "user.name=ctxpipe",
      "-c",
      "user.email=ctxpipe@example.invalid",
      "commit",
      "-q",
      "-m",
      "seed",
    ])
    const expected = await Promise.all(
      ["linear/issues/eng-1.md", "linear/issues/eng-1/assets/a b\tc.png"].map(
        async (path) => ({
          path,
          sha: (await nativeGit(directory, ["rev-parse", `HEAD:${path}`]))
            .toString()
            .trim(),
        }),
      ),
    )

    expect(
      (await listTreeBlobs(directory, "HEAD")).sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
    ).toEqual(expected.sort((a, b) => a.path.localeCompare(b.path)))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
