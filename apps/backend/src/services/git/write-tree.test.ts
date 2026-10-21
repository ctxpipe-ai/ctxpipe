import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mergeGitFiles } from "./merge-tree.js"
import {
  captureGitPack,
  type GitPack,
  nativeGit,
  readGitFiles,
  withGitDirectory,
} from "./pack.js"
import { stageUnbornGitFiles, validateUnbornGitTree } from "./unborn-tree.js"
import {
  commitGitTree,
  readGitCommitChanges,
  stageGitFiles,
  validateGitTree,
} from "./write-tree.js"

let directory: string
let base: GitPack

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ctxpipe-root-pack-"))
  await nativeGit(directory, ["init", "-q"])
  for (const [path, content] of Object.entries({
    "README.md": "# Monorepo\n",
    "src/app.ts": "export {}\n",
    "docs/context/AGENTS.md": "# Context\n",
    "docs/context/knowledge/services/a.md": "# A\n",
  })) {
    await mkdir(dirname(join(directory, path)), { recursive: true })
    await writeFile(join(directory, path), content)
  }
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
  const sha = (await nativeGit(directory, ["rev-parse", "HEAD"]))
    .toString()
    .trim()
  base = {
    ...(await captureGitPack(directory, sha, null)),
    root: "docs/context",
  }
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function treePaths(pack: GitPack): Promise<string[]> {
  return withGitDirectory(
    pack.sha,
    async (dir) =>
      (await nativeGit(dir, ["ls-tree", "-r", "--name-only", "-z", pack.sha]))
        .toString()
        .split("\0")
        .filter(Boolean),
    pack,
    null,
  )
}

describe("a pack with a Workspace root folder", () => {
  it("reads only the files below the root folder, as root-relative paths", async () => {
    expect(
      (await readGitFiles(base, () => true, undefined, null))
        .map((file) => file.path)
        .sort(),
    ).toEqual(["AGENTS.md", "knowledge/services/a.md"])
  })

  it("reads nothing when the root folder does not exist yet", async () => {
    expect(
      await readGitFiles(
        { ...base, root: "docs/new" },
        () => true,
        undefined,
        null,
      ),
    ).toEqual([])
  })

  it("writes root-relative paths below the root folder and keeps the root on the commit", async () => {
    const staged = await stageGitFiles(
      base,
      [{ path: "knowledge/services/b.md", content: "# B\n" }],
      ["knowledge/services/a.md"],
      null,
    )
    expect(
      await validateGitTree(
        staged,
        ["knowledge/services/a.md", "knowledge/services/b.md"],
        undefined,
        null,
      ),
    ).toEqual(["knowledge/services/a.md", "knowledge/services/b.md"])
    const committed = await commitGitTree(
      staged,
      {
        subject: "Change",
        createdAt: "2026-01-01T00:00:00Z",
      },
      null,
    )
    expect(committed.root).toBe("docs/context")
    expect(await treePaths(committed)).toEqual([
      "README.md",
      "docs/context/AGENTS.md",
      "docs/context/knowledge/services/b.md",
      "src/app.ts",
    ])
    expect(await readGitCommitChanges(committed, base.sha, null)).toEqual({
      files: [
        {
          path: "knowledge/services/b.md",
          content: Buffer.from("# B\n").toString("base64"),
          encoding: "base64",
        },
      ],
      deletePaths: ["knowledge/services/a.md"],
    })
  })

  it("refuses a path that leaves the root folder", async () => {
    await expect(
      stageGitFiles(
        base,
        [{ path: "../../src/app.ts", content: "x" }],
        undefined,
        null,
      ),
    ).rejects.toThrow()
    await expect(
      stageGitFiles(base, [], ["../../README.md"], null),
    ).rejects.toThrow()
  })

  it("keeps the repository root when the pack has no root folder", async () => {
    const { root: _root, ...plain } = base
    expect(
      (await readGitFiles(plain, () => true, undefined, null))
        .map((file) => file.path)
        .sort(),
    ).toEqual([
      "README.md",
      "docs/context/AGENTS.md",
      "docs/context/knowledge/services/a.md",
      "src/app.ts",
    ])
  })

  it("stages an unborn tree below the root folder", async () => {
    const tree = await stageUnbornGitFiles(
      [{ path: "AGENTS.md", content: "# Context\n" }],
      "docs/context",
    )
    await expect(
      validateUnbornGitTree(tree, ["AGENTS.md"], "docs/context"),
    ).resolves.toBeUndefined()
    await expect(validateUnbornGitTree(tree, ["AGENTS.md"])).rejects.toThrow()
  })

  it("merges a change below the root folder onto a tip that changed other folders", async () => {
    await writeFile(join(directory, "src/app.ts"), "export const moved = 1\n")
    await nativeGit(directory, [
      "-c",
      "user.name=ctxpipe",
      "-c",
      "user.email=ctxpipe@example.invalid",
      "commit",
      "-q",
      "-am",
      "outside",
    ])
    const tipSha = (await nativeGit(directory, ["rev-parse", "HEAD"]))
      .toString()
      .trim()
    const tip = {
      ...(await captureGitPack(directory, tipSha, null)),
      root: "docs/context",
    }
    const merged = await mergeGitFiles({
      pack: tip,
      previousSha: base.sha,
      read: null,
      files: [{ path: "knowledge/services/b.md", content: "# B\n" }],
      deletePaths: [],
    })
    expect(merged?.paths).toEqual(["knowledge/services/b.md"])
    expect(merged?.conflicts).toEqual([])
  })
})
