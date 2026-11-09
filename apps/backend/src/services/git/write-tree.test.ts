import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { prepareGitMerge } from "./merge-tree.js"
import {
  captureGitPack,
  type GitPack,
  nativeGit,
  readGitFiles,
  withGitDirectory,
} from "./pack.js"
import { prepareUnbornGitCommit } from "./unborn-tree.js"
import {
  commitGitTree,
  prepareGitCommit,
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

const remotes: string[] = []

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
  for (const remote of remotes.splice(0))
    await rm(remote, { recursive: true, force: true })
})

/** A bare repository that a publisher pushes to, with the seed commit. */
async function bareRemote(): Promise<string> {
  const remote = await mkdtemp(join(tmpdir(), "ctxpipe-write-remote-"))
  remotes.push(remote)
  await nativeGit(remote, ["init", "-q", "--bare"])
  await nativeGit(directory, [
    "push",
    "-q",
    remote,
    `${base.sha}:refs/heads/main`,
  ])
  return remote
}

/** Commit `src/app.ts` (and any other change in the work tree) on the seed: the new tip. */
async function commitOutside(app: string): Promise<GitPack> {
  await writeFile(join(directory, "src/app.ts"), app)
  await nativeGit(directory, [
    "-c",
    "user.name=ctxpipe",
    "-c",
    "user.email=ctxpipe@example.invalid",
    "commit",
    "-q",
    "-am",
    "tip",
  ])
  const sha = (await nativeGit(directory, ["rev-parse", "HEAD"]))
    .toString()
    .trim()
  return {
    ...(await captureGitPack(directory, sha, null, [base.sha])),
    root: "docs/context",
  }
}

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

  it("prepares a commit in one step, publishes it, and returns only its identity", async () => {
    const remote = await bareRemote()
    const published: string[] = []
    const prepare = () =>
      prepareGitCommit({
        pack: base,
        files: [{ path: "knowledge/services/b.md", content: "# B\n" }],
        deletePaths: ["knowledge/services/a.md"],
        subject: "Change",
        createdAt: "2026-01-01T00:00:00Z",
        read: null,
        publish: async (dir, sha) => {
          published.push(sha)
          await nativeGit(dir, [
            "push",
            "-q",
            remote,
            `${sha}:refs/ctxpipe/write/wjob_1/${sha}`,
          ])
        },
      })
    const committed = await prepare()
    expect(Object.keys(committed).sort()).toEqual([
      "base",
      "root",
      "sha",
      "tree",
    ])
    expect(committed).toMatchObject({ root: "docs/context", base: base.sha })
    // A replay makes the same commit and pushes the same ref again.
    expect(await prepare()).toEqual(committed)
    expect(published).toEqual([committed.sha, committed.sha])
    expect(
      (await nativeGit(remote, ["ls-tree", "-r", "--name-only", committed.sha]))
        .toString()
        .trim()
        .split("\n"),
    ).toEqual([
      "README.md",
      "docs/context/AGENTS.md",
      "docs/context/knowledge/services/b.md",
      "src/app.ts",
    ])
    expect(
      (await nativeGit(remote, ["rev-parse", `${committed.sha}^{tree}`]))
        .toString()
        .trim(),
    ).toBe(committed.tree)
  })

  it("prepares no commit for a change that changes nothing", async () => {
    await expect(
      prepareGitCommit({
        pack: base,
        files: [{ path: "AGENTS.md", content: "# Context\n" }],
        deletePaths: [],
        subject: "Change",
        createdAt: "2026-01-01T00:00:00Z",
        read: null,
        publish: () => Promise.reject(new Error("not reached")),
      }),
    ).rejects.toThrow("Invalid write tree")
  })

  it("prepares an unborn commit below the root folder and refuses a path outside its allowed paths", async () => {
    const remote = await bareRemote()
    const committed = await prepareUnbornGitCommit({
      files: [{ path: "AGENTS.md", content: "# Context\n" }],
      root: "docs/context",
      allowedPaths: ["AGENTS.md"],
      subject: "Bootstrap",
      createdAt: "2026-01-01T00:00:00Z",
      publish: (dir, sha) =>
        nativeGit(dir, [
          "push",
          "-q",
          remote,
          `${sha}:refs/ctxpipe/write/wjob_1/${sha}`,
        ]).then(() => undefined),
    })
    expect(committed).toMatchObject({ root: "docs/context", base: null })
    expect(
      (await nativeGit(remote, ["ls-tree", "-r", "--name-only", committed.sha]))
        .toString()
        .trim(),
    ).toBe("docs/context/AGENTS.md")
    await expect(
      prepareUnbornGitCommit({
        files: [{ path: "AGENTS.md", content: "# Context\n" }],
        root: "docs/context",
        allowedPaths: ["README.md"],
        subject: "Bootstrap",
        createdAt: "2026-01-01T00:00:00Z",
        publish: () => Promise.reject(new Error("not reached")),
      }),
    ).rejects.toThrow("Invalid bootstrap root tree")
  })

  it("merges a change below the root folder onto a tip that changed other folders", async () => {
    const tip = await commitOutside("export const moved = 1\n")
    const remote = await bareRemote()
    const committed = await prepareGitMerge({
      pack: tip,
      previousSha: base.sha,
      files: [{ path: "knowledge/services/b.md", content: "# B\n" }],
      deletePaths: [],
      resolve: () => Promise.reject(new Error("no conflict expected")),
      subject: "Merge",
      createdAt: "2026-01-01T00:00:00Z",
      read: null,
      publish: (dir, sha) =>
        nativeGit(dir, [
          "push",
          "-q",
          remote,
          `${sha}:refs/ctxpipe/write/wjob_1/${sha}`,
        ]).then(() => undefined),
    })
    expect(committed).toMatchObject({ root: "docs/context", base: tip.sha })
    expect(
      (
        await nativeGit(remote, [
          "diff-tree",
          "-r",
          "--name-only",
          "--no-commit-id",
          tip.sha,
          committed?.sha ?? "",
        ])
      )
        .toString()
        .trim(),
    ).toBe("docs/context/knowledge/services/b.md")
  })

  it("asks the resolver for a conflict and commits only its resolution", async () => {
    await writeFile(join(directory, "docs/context/AGENTS.md"), "# Tip\n")
    const tip = await commitOutside("export {}\n")
    let asked: unknown
    const committed = await prepareGitMerge({
      pack: tip,
      previousSha: base.sha,
      files: [{ path: "AGENTS.md", content: "# Incoming\n" }],
      deletePaths: [],
      resolve: async (conflicts) => {
        asked = conflicts
        return [{ path: "AGENTS.md", content: "# Resolved\n" }]
      },
      subject: "Merge",
      createdAt: "2026-01-01T00:00:00Z",
      read: null,
      publish: async () => {},
    })
    expect(asked).toEqual([
      {
        path: "AGENTS.md",
        base: "# Context\n",
        current: "# Tip\n",
        incoming: "# Incoming\n",
      },
    ])
    expect(committed?.base).toBe(tip.sha)
    // A resolution for a path that the merge does not change is refused.
    await expect(
      prepareGitMerge({
        pack: tip,
        previousSha: base.sha,
        files: [{ path: "AGENTS.md", content: "# Incoming\n" }],
        deletePaths: [],
        resolve: async () => [
          { path: "AGENTS.md", content: "# Resolved\n" },
          { path: "knowledge/services/a.md", content: "# Changed\n" },
        ],
        subject: "Merge",
        createdAt: "2026-01-01T00:00:00Z",
        read: null,
        publish: async () => {},
      }),
    ).rejects.toThrow("Invalid write tree")
  })
})
