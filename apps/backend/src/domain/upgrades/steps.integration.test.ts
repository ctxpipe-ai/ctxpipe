import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  type GitPack,
  readGitPackFromRemote,
  withGitDirectory,
} from "../../services/git/pack.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import {
  CODE_FORMAT,
  WORKSPACE_FORMAT_PATH,
} from "../workspaces/workspace-format.js"
import { buildUpgradeCommits } from "./build-commits.js"
import {
  GIT_UPGRADE_STEPS_AFTER_EXPORT,
  type GitUpgradeStep,
  upgradeTargetFormat,
} from "./registry.js"

/** Stands in for step 1 (CTX-743), which is built at the same time. It changes nothing. */
const STEP_1: GitUpgradeStep = {
  format: 1,
  title: "Export (stand-in)",
  plan: async () => ({ writes: [], deletes: [], report: [] }),
}

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
const directories: string[] = []

beforeAll(async () => {
  seed = await seedSourcesOrg("upgrade_steps")
})
afterAll(async () => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
  await seed.cleanup()
})

async function fixturePack(files: Record<string, string>): Promise<GitPack> {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-upgrade-steps-"))
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
  })
}

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

describe("upgrade steps 2 and 3 (Postgres + git)", () => {
  it("reach the code format with no gap after step 1", () => {
    const steps = [STEP_1, ...GIT_UPGRADE_STEPS_AFTER_EXPORT]
    expect(GIT_UPGRADE_STEPS_AFTER_EXPORT.map((step) => step.format)).toEqual([
      2, 3,
    ])
    expect(upgradeTargetFormat(steps)).toBe(CODE_FORMAT)
  })

  it("convert the sources and move the old extracted files in one commit each, and a second run changes nothing", async () => {
    const workspaceName = `acme/context-${seed.suffix.replaceAll("_", "-")}`
    const workspaceUrl = `https://github.com/${workspaceName}.git`
    const workspaceId = await seed.addWorkspace("steps", workspaceUrl)
    const ctx = { orgId: seed.orgId, workspaceId, baseSha: "" }
    const steps = [STEP_1, ...GIT_UPGRADE_STEPS_AFTER_EXPORT]
    const base = await fixturePack({
      ".ctxpipe/sources.yaml": `version: 1
sources:
  - id: linked-repositories
    provider: github
    connection: con_example
    repositories: [acme/billing, ${workspaceName}]
`,
      "knowledge/services/billing.md":
        "---\nkind: Service\ngenerated_by: ctxpipe\nsource: https://github.com/acme/billing.git#src/index.ts\n---\n\n# Billing\n",
      "knowledge/notes.md": "---\nkind: Note\n---\n\nA human note.\n",
      // No source file names this repository, so no source path can own it.
      "knowledge/services/orphan.md":
        "---\nkind: Service\ngenerated_by: ctxpipe\nsource: https://github.com/acme/orphan.git#src/index.ts\n---\n\n# Orphan\n",
    })
    const built = await buildUpgradeCommits({
      pack: { ...base },
      steps,
      fromFormat: 0,
      targetFormat: CODE_FORMAT,
      ctx: { ...ctx, baseSha: base.sha },
      createdAt: "2026-10-16T00:00:00.000Z",
    })
    expect(built.steps.map((step) => [step.format, step.sha !== null])).toEqual(
      [
        [1, false],
        [2, true],
        [3, true],
      ],
    )
    const head = await readCommits(built.pack)
    expect(head.subjects).toEqual([
      "ctx| upgrade: set the Workspace format to 3",
      "ctx| upgrade to format 3: Ingestion v2 ownership of extracted files",
      "ctx| upgrade to format 2: One file for each source under sources/",
      "Base",
    ])
    expect(head.files).not.toContain(".ctxpipe/sources.yaml")
    // Step 2 skips the entry of the Workspace repository.
    expect(head.files.filter((path) => path.startsWith("sources/"))).toEqual([
      "sources/github/acme/billing.md",
    ])
    expect(head.show("sources/github/acme/billing.md")).toBe(
      "---\nprovider: github\nconnection: con_example\nrepository: acme/billing\n---",
    )
    expect(head.show("knowledge/services/billing.md")).toContain(
      "generated_by: ctxpipe-extract",
    )
    expect(head.show("knowledge/services/billing.md")).toContain(
      "sources/github/acme/billing.md",
    )
    expect(head.show("knowledge/services/orphan.md")).toContain(
      "generated_by: ctxpipe\n",
    )
    expect(head.show("knowledge/notes.md")).toBe(
      "---\nkind: Note\n---\n\nA human note.",
    )
    expect(head.show(WORKSPACE_FORMAT_PATH)).toContain("format: 3")

    // Each step on its own output changes nothing.
    const again = await buildUpgradeCommits({
      pack: built.pack,
      steps,
      fromFormat: 0,
      targetFormat: CODE_FORMAT,
      ctx: { ...ctx, baseSha: built.pack.sha },
      createdAt: "2026-10-16T00:00:00.000Z",
    })
    expect(again.pack.sha).toBe(built.pack.sha)
    expect(again.steps.every((step) => step.sha === null)).toBe(true)
  })
})
