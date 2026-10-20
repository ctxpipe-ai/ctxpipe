import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parse, stringify } from "yaml"
import { captureGitPack } from "../../services/git/pack.js"
import { planUnlinkRetraction } from "./unlink-retraction.js"

const UNLINKED = "https://github.com/acme/billing"
const OTHER = "https://github.com/acme/ledger"
// The source files of the two repositories: the values of `sources` and of
// the area file source lines (ADR-050 revision 2026-10-16).
const UNLINKED_PATH = "sources/github/acme/billing.md"
const OTHER_PATH = "sources/github/acme/ledger.md"
const WORKSPACE = "https://github.com/acme/context"
const OBSERVED = "2026-10-15T00:00:00.000Z"
const HUMAN =
  "<!-- ctxpipe:human -->\nA note that a human wrote.\n<!-- /ctxpipe:human -->\n"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function doc(front: Record<string, unknown>, body: string): string {
  return `---\n${stringify(front, { lineWidth: 0 })}---\n${body}`
}

function host(sources: string[]) {
  return {
    generated_by: "ctxpipe-extract",
    sources,
    source_sha: "a".repeat(40),
    skill: "codebase",
    bundle: "b1",
  }
}

const legacyOpen = {
  to: "../libraries/zod.md",
  predicate: "DEPENDS_ON",
  source: `${UNLINKED}.git#package.json`,
  valid_from: "2025-01-01T00:00:00.000Z",
  evidence: { kind: "legacy" },
}
const legacyClosed = {
  to: "../libraries/yup.md",
  predicate: "DEPENDS_ON",
  source: `${UNLINKED}.git#package.json`,
  valid_from: "2024-01-01T00:00:00.000Z",
  valid_to: "2024-06-01T00:00:00.000Z",
  evidence: { kind: "legacy" },
}

const area = (rules: string, notes: string) =>
  `# Unit testing\n\n## Summary\n\nHow the code is tested.\n\n## Rules\n\n${rules}\n## Repository notes\n\n${notes}`

async function workspace(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "unlink-retraction-"))
  dirs.push(dir)
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
      },
    }).trim()
  git("init", "--quiet", "-b", "main")
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  git("add", "-A")
  git("commit", "--quiet", "-m", "fixture")
  return captureGitPack(dir, git("rev-parse", "HEAD"))
}

function plan(pack: Awaited<ReturnType<typeof workspace>>) {
  return planUnlinkRetraction({
    pack,
    sourceUrl: `${UNLINKED}.git`,
    sourcePath: UNLINKED_PATH,
    workspaceRepositoryUrl: WORKSPACE,
    observedAt: OBSERVED,
  })
}

describe("planUnlinkRetraction", () => {
  it("deletes each file that the unlinked repository owns alone, also a migrated one", async () => {
    const pack = await workspace({
      "knowledge/services/billing.md": doc(
        { kind: "Service", name: "Billing", ...host([UNLINKED_PATH]) },
        "# Billing\n",
      ),
      "knowledge/services/invoices.md": doc(
        {
          kind: "Service",
          name: "Invoices",
          claims: [legacyOpen, legacyClosed],
          ...host([UNLINKED_PATH]),
        },
        "# Invoices\n",
      ),
      "knowledge/services/ledger.md": doc(
        { kind: "Service", name: "Ledger", ...host([OTHER_PATH]) },
        "# Ledger\n",
      ),
    })
    const result = await plan(pack)
    expect(result.deletePaths).toEqual([
      "knowledge/services/billing.md",
      "knowledge/services/invoices.md",
    ])
    expect(result.files).toEqual([])
  })

  it("retracts by the removed source path, not by the repository URL", async () => {
    const pack = await workspace({
      "knowledge/services/billing.md": doc(
        { kind: "Service", name: "Billing", ...host([UNLINKED_PATH]) },
        "# Billing\n",
      ),
      // The repository URL is not a source path, so no source owns this file.
      "knowledge/services/by-url.md": doc(
        { kind: "Service", name: "By URL", ...host([UNLINKED]) },
        "# By URL\n",
      ),
      // The same repository from another source file of the Workspace.
      "knowledge/services/renamed.md": doc(
        {
          kind: "Service",
          name: "Renamed",
          ...host(["sources/github/acme/billing-main.md"]),
        },
        "# Renamed\n",
      ),
    })
    const result = await plan(pack)
    expect(result.deletePaths).toEqual(["knowledge/services/billing.md"])
    expect(result.files).toEqual([])
  })

  it("closes only the open claims of the repository in a file of another source, and keeps the dates of closed claims", async () => {
    const otherClaim = {
      to: "../libraries/zod.md",
      predicate: "USES",
      evidence: { path: "src/index.ts", kind: "script" },
      confidence: 0.7,
    }
    const pack = await workspace({
      "knowledge/services/ledger.md": doc(
        {
          kind: "Service",
          name: "Ledger",
          claims: [legacyOpen, legacyClosed, otherClaim],
          ...host([OTHER_PATH]),
        },
        `# Ledger\n\nText.\n\n${HUMAN}`,
      ),
    })
    const result = await plan(pack)
    expect(result.deletePaths).toEqual([])
    const [file] = result.files
    expect(file?.path).toBe("knowledge/services/ledger.md")
    const front = parse(file?.content.split("---\n")[1] ?? "")
    expect(front.claims).toEqual([
      { ...legacyOpen, valid_to: OBSERVED },
      legacyClosed,
      otherClaim,
    ])
    expect(front.sources).toEqual([OTHER_PATH])
    expect(file?.content.endsWith(`# Ledger\n\nText.\n\n${HUMAN}`)).toBe(true)
  })

  it("removes only the evidence and notes of the repository from a shared area file", async () => {
    const before = area(
      [
        "- Use vitest.",
        "  - topic: `runner` = `vitest` (core)",
        `  - source \`${UNLINKED_PATH}\`, documented: \`README.md\``,
        `  - source \`${OTHER_PATH}\`, documented: \`docs/testing.md\``,
        "- Name tests after the behavior.",
        "  - topic: `naming` = `behavior`",
        `  - source \`${UNLINKED_PATH}\`, documented: \`CONTRIBUTING.md\``,
        "",
      ].join("\n"),
      `- \`${UNLINKED_PATH}\`: Billing runs tests in CI.\n- \`${OTHER_PATH}\`: Ledger runs tests locally.\n`,
    )
    const pack = await workspace({
      "knowledge/instructions/unit-testing.md": `${doc(
        {
          kind: "InstructionUnit",
          name: "Unit testing",
          ...host([UNLINKED_PATH, OTHER_PATH]),
        },
        before,
      )}\n${HUMAN}`,
    })
    const result = await plan(pack)
    expect(result.deletePaths).toEqual([])
    const [file] = result.files
    const front = parse(file?.content.split("---\n")[1] ?? "")
    expect(front.sources).toEqual([OTHER_PATH])
    expect(file?.content).toContain(`source \`${OTHER_PATH}\`, documented`)
    expect(file?.content).toContain("- Use vitest.")
    expect(file?.content).not.toContain(UNLINKED_PATH)
    expect(file?.content).not.toContain("Name tests after the behavior")
    expect(file?.content).toContain("Ledger runs tests locally")
    expect(file?.content.endsWith(`\n${HUMAN}`)).toBe(true)
  })

  it("gives a file that it owns alone, but with a human section, to the humans", async () => {
    const own = {
      to: "../libraries/zod.md",
      predicate: "USES",
      evidence: { path: "src/index.ts", kind: "script" },
      confidence: 0.7,
    }
    const body = `# Billing\n\nExtracted text.\n\n${HUMAN}`
    const pack = await workspace({
      "knowledge/services/billing.md": doc(
        {
          kind: "Service",
          name: "Billing",
          claims: [own, legacyOpen, legacyClosed],
          ...host([UNLINKED_PATH]),
          root: ".",
        },
        body,
      ),
    })
    const result = await plan(pack)
    expect(result.deletePaths).toEqual([])
    const [file] = result.files
    const front = parse(file?.content.split("---\n")[1] ?? "")
    expect(front).toEqual({
      kind: "Service",
      name: "Billing",
      claims: [{ ...legacyOpen, valid_to: OBSERVED }, legacyClosed],
    })
    expect(file?.content.endsWith(body)).toBe(true)
  })

  it("retracts an old pipeline file of the repository that is not migrated yet, as the migration would give it to the repository", async () => {
    const old = (source: string, extra: Record<string, unknown> = {}) => ({
      kind: "Service",
      generated_by: "ctxpipe",
      source,
      import_key: "billing:service",
      confidence: 0.6,
      ...extra,
    })
    const oldOpen = {
      to: "../libraries/zod.md",
      predicate: "DEPENDS_ON",
      source: `${UNLINKED}.git#package.json`,
      valid_from: "2025-01-01T00:00:00.000Z",
    }
    const body = `# Billing\n\nOld text.\n\n${HUMAN}`
    const pack = await workspace({
      "knowledge/services/billing.md": doc(
        old(`${UNLINKED}.git#src/index.ts`),
        "# Billing\n",
      ),
      "knowledge/services/billing-notes.md": doc(
        old(`git@github.com:acme/billing.git`, { claims: [oldOpen] }),
        body,
      ),
      "knowledge/services/ledger.md": doc(
        old(`${OTHER}.git#src/index.ts`),
        "# Ledger\n",
      ),
      // A relative source: no source repository can own it.
      "knowledge/services/local.md": doc(old("src/index.ts"), "# Local\n"),
    })
    const result = await plan(pack)
    expect(result.deletePaths).toEqual(["knowledge/services/billing.md"])
    expect(result.files.map((file) => file.path)).toEqual([
      "knowledge/services/billing-notes.md",
    ])
    const content = result.files[0]?.content ?? ""
    const front = parse(content.split("---\n")[1] ?? "")
    // The file goes to the humans; its old claim closes and stays as history.
    expect(front.generated_by).toBeUndefined()
    expect(front.sources).toBeUndefined()
    expect(front.source).toBeUndefined()
    expect(front.claims).toEqual([
      {
        confidence: 0.6,
        ...oldOpen,
        evidence: { kind: "legacy" },
        valid_to: OBSERVED,
      },
    ])
    expect(content.endsWith(body)).toBe(true)
  })

  it("leaves an old pipeline file outside the allowed knowledge folders unchanged, and lists it", async () => {
    const pack = await workspace({
      // Not a knowledge folder of the allowlist: the validator refuses it.
      "knowledge/topics/billing.md": doc(
        {
          kind: "Topic",
          generated_by: "ctxpipe",
          source: `${UNLINKED}.git#src/index.ts`,
        },
        "# Billing\n",
      ),
      "knowledge/services/billing.md": doc(
        { kind: "Service", name: "Billing", ...host([UNLINKED_PATH]) },
        "# Billing\n",
      ),
    })
    expect(await plan(pack)).toEqual({
      files: [],
      deletePaths: ["knowledge/services/billing.md"],
      skipped: [
        {
          path: "knowledge/topics/billing.md",
          reason: "Only the knowledge folders of the allowlist are allowed",
        },
      ],
    })
  })

  it("removes the evidence of the repository also after a human section in the middle of a shared area file", async () => {
    const human =
      "<!-- ctxpipe:human -->\nRun the slow tests at night.\n<!-- /ctxpipe:human -->"
    const body = area(
      [
        "- Use vitest.",
        "  - topic: `runner` = `vitest` (core)",
        `  - source \`${UNLINKED_PATH}\`, documented: \`README.md\``,
        `  - source \`${OTHER_PATH}\`, documented: \`docs/testing.md\``,
        human,
        "- Name tests after the behavior.",
        "  - topic: `naming` = `behavior`",
        `  - source \`${UNLINKED_PATH}\`, documented: \`CONTRIBUTING.md\``,
        "- Keep tests fast.",
        "  - topic: `speed` = `fast`",
        `  - source \`${UNLINKED_PATH}\`, documented: \`docs/speed.md\``,
        `  - source \`${OTHER_PATH}\`, documented: \`docs/speed.md\``,
        "",
      ].join("\n"),
      `- \`${UNLINKED_PATH}\`: Billing runs tests in CI.\n- \`${OTHER_PATH}\`: Ledger runs tests locally.\n`,
    )
    const pack = await workspace({
      "knowledge/instructions/unit-testing.md": doc(
        {
          kind: "InstructionUnit",
          name: "Unit testing",
          ...host([UNLINKED_PATH, OTHER_PATH]),
        },
        body,
      ),
    })
    const result = await plan(pack)
    const [file] = result.files
    const content = file?.content ?? ""
    expect(parse(content.split("---\n")[1] ?? "").sources).toEqual([OTHER_PATH])
    // No evidence line or note of the repository stays, before or after the
    // human section, and the human section stays in its place.
    expect(content).not.toContain(UNLINKED_PATH)
    expect(content).not.toContain("Name tests after the behavior")
    expect(content).toContain(
      `  - source \`${OTHER_PATH}\`, documented: \`docs/testing.md\`\n${human}\n- Keep tests fast.`,
    )
    expect(content).toContain(
      `source \`${OTHER_PATH}\`, documented: \`docs/speed.md\``,
    )
  })

  it("refuses a retraction that would move a human section out of a rule that goes", async () => {
    const human =
      "<!-- ctxpipe:human -->\nOnly on main.\n<!-- /ctxpipe:human -->"
    const pack = await workspace({
      "knowledge/instructions/unit-testing.md": doc(
        {
          kind: "InstructionUnit",
          name: "Unit testing",
          ...host([UNLINKED_PATH, OTHER_PATH]),
        },
        area(
          [
            "- Use vitest.",
            "  - topic: `runner` = `vitest` (core)",
            `  - source \`${OTHER_PATH}\`, documented: \`docs/testing.md\``,
            "- Name tests after the behavior.",
            human,
            "  - topic: `naming` = `behavior`",
            `  - source \`${UNLINKED_PATH}\`, documented: \`CONTRIBUTING.md\``,
            "",
          ].join("\n"),
          `- \`${OTHER_PATH}\`: Ledger runs tests locally.\n`,
        ),
      ),
    })
    await expect(plan(pack)).rejects.toThrow(
      /unit-testing\.md (would move|has a form)/,
    )
  })

  it("changes nothing when the repository owns no file and has no open claim", async () => {
    const pack = await workspace({
      "knowledge/services/ledger.md": doc(
        { kind: "Service", name: "Ledger", ...host([OTHER_PATH]) },
        "# Ledger\n",
      ),
      "knowledge/notes.md": "# Notes\n",
    })
    expect(await plan(pack)).toEqual({
      files: [],
      deletePaths: [],
      skipped: [],
    })
  })
})
