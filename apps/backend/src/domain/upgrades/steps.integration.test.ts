import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  type GitPack,
  readGitFiles,
  readGitPackFromRemote,
  withGitDirectory,
} from "../../services/git/pack.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { planHydrateWrites } from "../workspaces/hydrate-write-planner.js"
import { KNOWLEDGE_SKILL_PATH } from "../workspaces/layout.js"
import {
  CODE_FORMAT,
  WORKSPACE_FORMAT_PATH,
} from "../workspaces/workspace-format.js"
import { buildUpgradeCommits } from "./build-commits.js"
import { GIT_UPGRADE_STEPS, upgradeTargetFormat } from "./registry.js"

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
  it("reach the code format with no gap", () => {
    expect(GIT_UPGRADE_STEPS.map((step) => step.format)).toEqual([1, 2, 3])
    expect(upgradeTargetFormat(GIT_UPGRADE_STEPS)).toBe(CODE_FORMAT)
  })

  it("convert the sources and move the old extracted files in one commit each, and a second run changes nothing", async () => {
    const workspaceName = `acme/context-${seed.suffix.replaceAll("_", "-")}`
    const workspaceUrl = `https://github.com/${workspaceName}.git`
    const workspaceId = await seed.addWorkspace("steps", workspaceUrl)
    const ctx = {
      orgId: seed.orgId,
      workspaceId,
      baseSha: "",
      remote: { url: workspaceUrl, connectionId: null },
      introducedAt: async () =>
        new Map([["knowledge/guides/deploy.md", "2025-01-02T03:04:05.000Z"]]),
    }
    const steps = GIT_UPGRADE_STEPS
    const inOrg = <T>(fn: () => Promise<T>) =>
      withOrgIdContext({ id: seed.orgId, slug: seed.orgId }, fn)
    const base = await fixturePack({
      ".ctxpipe/sources.yaml": `version: 1
sources:
  - id: linked-repositories
    provider: github
    connection: con_example
    repositories: [acme/billing, ${workspaceName}]
`,
      // Step 3 removes the keys that ingestion v2 does not know, and a
      // summary over 1000 characters. The report names them.
      "knowledge/services/billing.md": `---\nkind: Service\ngenerated_by: ctxpipe\nsource: https://github.com/acme/billing.git#src/index.ts\nowner: team-payments\nsummary: ${"a".repeat(1001)}\n---\n\n# Billing\n`,
      "knowledge/notes.md": "---\nkind: Note\n---\n\nA human note.\n",
      // A link with no claim: hydrate at format 3 adds the claim and its
      // valid_from, so the upgrade pull request adds them.
      "knowledge/guides/deploy.md":
        "---\nkind: Guide\n---\n\nDeploy [billing](../services/billing.md) first.\n",
      // An AGENTS.md with no folder section and the retired markers.
      "AGENTS.md":
        "---\nname: Context\n---\n\nRead the guides.\n<!-- ctxpipe:folder-map -->\n<!-- /ctxpipe:folder-map -->\n",
      // No source file names this repository, so no source path can own it.
      "knowledge/services/orphan.md":
        "---\nkind: Service\ngenerated_by: ctxpipe\nsource: https://github.com/acme/orphan.git#src/index.ts\n---\n\n# Orphan\n",
    })
    const built = await inOrg(() =>
      buildUpgradeCommits({
        pack: { ...base },
        steps,
        fromFormat: 0,
        targetFormat: CODE_FORMAT,
        ctx: { ...ctx, baseSha: base.sha },
        createdAt: "2026-10-16T00:00:00.000Z",
      }),
    )
    expect(built.steps.map((step) => [step.format, step.sha !== null])).toEqual(
      [
        [1, false],
        [2, true],
        [3, true],
      ],
    )
    expect(built.steps.find((step) => step.format === 3)?.report).toContain(
      "knowledge/services/billing.md: removed the front matter keys `owner`, `summary`. Ingestion v2 does not accept these keys or their values.",
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
    const deploy = head.show("knowledge/guides/deploy.md") ?? ""
    expect(deploy).toContain("to: ../services/billing.md")
    expect(deploy).toContain("valid_from: 2025-01-02T03:04:05.000Z")
    const agentsMd = head.show("AGENTS.md") ?? ""
    expect(agentsMd).toContain("Read the guides.")
    expect(agentsMd).toContain("## Folder Structure")
    expect(agentsMd).not.toContain("ctxpipe:folder-map")
    expect(head.files).toContain(KNOWLEDGE_SKILL_PATH)

    // Hydrate on the merged tree plans no direct write.
    const markdown = await readGitFiles(built.pack, (path) =>
      path.endsWith(".md"),
    )
    expect(
      await planHydrateWrites({
        revision: {
          workspaceId,
          generation: 1,
          remote: { url: workspaceUrl, connectionId: null },
          defaultBranch: "main",
          sha: built.pack.sha,
          access: "read",
        },
        displayName: "steps",
        files: markdown,
        sourceFiles: markdown
          .filter((file) => file.path.startsWith("sources/"))
          .map((file) => ({ path: file.path, text: file.content })),
        sourceRows: [],
        format: 3,
      }),
    ).toEqual([])

    // Each step on its own output changes nothing.
    const again = await inOrg(() =>
      buildUpgradeCommits({
        pack: built.pack,
        steps,
        fromFormat: 0,
        targetFormat: CODE_FORMAT,
        ctx: { ...ctx, baseSha: built.pack.sha },
        createdAt: "2026-10-16T00:00:00.000Z",
      }),
    )
    expect(again.pack.sha).toBe(built.pack.sha)
    expect(again.steps.every((step) => step.sha === null)).toBe(true)
  })
})
