import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  type GitPack,
  readGitPackFromRemote,
  withGitDirectory,
} from "../../services/git/pack.js"
import { WORKSPACE_FORMAT_PATH } from "../workspaces/workspace-format.js"
import { buildUpgradeCommits, upgradePullRequestText } from "./build-commits.js"
import {
  GIT_UPGRADE_STEPS,
  type GitUpgradeStep,
  pendingUpgradeSteps,
  upgradeTargetFormat,
} from "./registry.js"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

/** A real repository with one commit, captured as a depth-1 pack. */
async function fixturePack(
  files: Record<string, string>,
  root = "",
): Promise<GitPack> {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-upgrade-build-"))
  directories.push(directory)
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
  git("init", "-q", "-b", "main")
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), body)
  }
  git("add", ".")
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "-m",
    "Base",
  )
  return readGitPackFromRemote({
    url: directory,
    sha: git("rev-parse", "HEAD"),
    ...(root ? { root } : {}),
  })
}

/** The subjects from the head to the base, and the files of the head. */
async function readCommits(pack: GitPack) {
  return withGitDirectory(
    pack.sha,
    async (directory) => {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
      const files = git("ls-tree", "-r", "--name-only", pack.sha).split("\n")
      const contents = new Map(
        files.map((path) => [path, git("show", `${pack.sha}:${path}`)]),
      )
      return {
        subjects: git("log", "--format=%s", pack.sha).split("\n"),
        files,
        show: (path: string) => contents.get(path),
      }
    },
    pack,
  )
}

/** Test steps: 1 adds a file, 2 changes nothing, 3 reads the file of step 1. */
const STEPS: GitUpgradeStep[] = [
  {
    format: 1,
    title: "Add notes",
    plan: async () => ({
      writes: [{ path: "notes/a.md", content: "A\n" }],
      deletes: [],
      report: ["Added notes/a.md"],
    }),
  },
  {
    format: 2,
    title: "Keep the readme",
    plan: async (tree) => ({
      writes: [
        { path: "README.md", content: (await tree.read("README.md")) ?? "" },
      ],
      deletes: ["missing.md"],
      report: [],
    }),
  },
  {
    format: 3,
    title: "Move notes",
    plan: async (tree) => {
      const a = await tree.read("notes/a.md")
      if (a === null) return { writes: [], deletes: [], report: [] }
      return {
        writes: [{ path: "notes/b.md", content: `${a}then B\n` }],
        deletes: ["old.md"],
        report: [
          `Moved ${tree.paths().filter((path) => path.startsWith("notes/")).length} note`,
        ],
      }
    },
  },
]

describe("buildUpgradeCommits", () => {
  it("makes one commit for each step that changes a file, in order, and bumps the format last", async () => {
    const base = await fixturePack({
      "README.md": "# Readme\n",
      "old.md": "x\n",
    })
    const createdAt = "2026-10-16T00:00:00.000Z"
    const built = await buildUpgradeCommits({
      pack: base,
      steps: STEPS,
      fromFormat: 0,
      targetFormat: 3,
      ctx: { orgId: "org_test", workspaceId: "ws_test", baseSha: base.sha },
      createdAt,
    })
    expect(built.steps.map((step) => [step.format, step.sha !== null])).toEqual(
      [
        [1, true],
        [2, false],
        [3, true],
      ],
    )
    const commits = await readCommits(built.pack)
    expect(commits.subjects).toEqual([
      "ctx| upgrade: set the Workspace format to 3",
      "ctx| upgrade to format 3: Move notes",
      "ctx| upgrade to format 1: Add notes",
      "Base",
    ])
    expect(commits.files.sort()).toEqual(
      [
        ".ctxpipe/workspace.yaml",
        "README.md",
        "notes/a.md",
        "notes/b.md",
      ].sort(),
    )
    expect(commits.show("notes/b.md")).toBe("A\nthen B")
    expect(commits.show(WORKSPACE_FORMAT_PATH)).toContain("format: 3")

    // The same base, steps and time give the same commits: a replay pushes the same SHA.
    const again = await buildUpgradeCommits({
      pack: base,
      steps: STEPS,
      fromFormat: 0,
      targetFormat: 3,
      ctx: { orgId: "org_test", workspaceId: "ws_test", baseSha: base.sha },
      createdAt,
    })
    expect(again.pack.sha).toBe(built.pack.sha)

    // A second plan of each step on the output changes nothing.
    const rerun = await buildUpgradeCommits({
      pack: built.pack,
      steps: STEPS,
      fromFormat: 0,
      targetFormat: 3,
      ctx: {
        orgId: "org_test",
        workspaceId: "ws_test",
        baseSha: built.pack.sha,
      },
      createdAt,
    })
    expect(rerun.steps.every((step) => step.sha === null)).toBe(true)

    const text = upgradePullRequestText({
      fromFormat: 0,
      targetFormat: 3,
      steps: built.steps,
    })
    expect(text.body).toContain("### Format 1: Add notes\n- Added notes/a.md")
    expect(text.body).toContain(
      "### Format 2: Keep the readme\n- No change was necessary.",
    )
    expect(text.body).toContain("### Format 3: Move notes\n- Moved 1 note")
  })

  it("runs only the steps above the current format", async () => {
    const base = await fixturePack({ "notes/a.md": "A\n", "old.md": "x\n" })
    const built = await buildUpgradeCommits({
      pack: base,
      steps: STEPS,
      fromFormat: 2,
      targetFormat: 3,
      ctx: { orgId: "org_test", workspaceId: "ws_test", baseSha: base.sha },
      createdAt: "2026-10-16T00:00:00.000Z",
    })
    expect(built.steps.map((step) => step.format)).toEqual([3])
    expect((await readCommits(built.pack)).subjects).toHaveLength(3)
  })

  it("writes only below the Workspace root folder", async () => {
    const base = await fixturePack(
      {
        "ctx/README.md": "# Readme\n",
        "ctx/old.md": "x\n",
        "outside.md": "keep\n",
      },
      "ctx",
    )
    const built = await buildUpgradeCommits({
      pack: base,
      steps: STEPS,
      fromFormat: 0,
      targetFormat: 3,
      ctx: { orgId: "org_test", workspaceId: "ws_test", baseSha: base.sha },
      createdAt: "2026-10-16T00:00:00.000Z",
    })
    const commits = await readCommits(built.pack)
    expect(commits.files.sort()).toEqual(
      [
        "ctx/.ctxpipe/workspace.yaml",
        "ctx/README.md",
        "ctx/notes/a.md",
        "ctx/notes/b.md",
        "outside.md",
      ].sort(),
    )
  })

  it("refuses a step that writes the format file", async () => {
    const base = await fixturePack({ "README.md": "# Readme\n" })
    await expect(
      buildUpgradeCommits({
        pack: base,
        steps: [
          {
            format: 1,
            title: "Bad",
            plan: async () => ({
              writes: [{ path: WORKSPACE_FORMAT_PATH, content: "format: 9\n" }],
              deletes: [],
              report: [],
            }),
          },
        ],
        fromFormat: 0,
        targetFormat: 1,
        ctx: { orgId: "org_test", workspaceId: "ws_test", baseSha: base.sha },
        createdAt: "2026-10-16T00:00:00.000Z",
      }),
    ).rejects.toThrow(/must not change/)
  })
})

describe("the upgrade registry", () => {
  it("accepts only contiguous steps from format 1", () => {
    expect(upgradeTargetFormat(STEPS)).toBe(3)
    expect(upgradeTargetFormat([])).toBe(0)
    expect(() => upgradeTargetFormat([STEPS[1] as GitUpgradeStep])).toThrow(
      /missing or out of order/,
    )
    expect(() =>
      upgradeTargetFormat([
        ...STEPS,
        { ...(STEPS[0] as GitUpgradeStep), format: 4 },
      ]),
    ).toThrow(/above the code format/)
    expect(pendingUpgradeSteps(STEPS, 1, 3).map((step) => step.format)).toEqual(
      [2, 3],
    )
  })
})

describe("the production registry", () => {
  it("is contiguous, and a second plan of each step on its own output changes nothing", async () => {
    const target = upgradeTargetFormat(GIT_UPGRADE_STEPS)
    const base = await fixturePack({ "README.md": "# Readme\n" })
    const ctx = { orgId: "org_test", workspaceId: "ws_test", baseSha: base.sha }
    const built = await buildUpgradeCommits({
      pack: base,
      steps: GIT_UPGRADE_STEPS,
      fromFormat: 0,
      targetFormat: target,
      ctx,
      createdAt: "2026-10-16T00:00:00.000Z",
    })
    const rerun = await buildUpgradeCommits({
      pack: built.pack,
      steps: GIT_UPGRADE_STEPS,
      fromFormat: 0,
      targetFormat: target,
      ctx: { ...ctx, baseSha: built.pack.sha },
      createdAt: "2026-10-16T00:00:00.000Z",
    })
    expect(rerun.steps.filter((step) => step.sha !== null)).toEqual([])
  })
})
