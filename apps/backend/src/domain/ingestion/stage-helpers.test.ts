import { execFileSync, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { stringify } from "yaml"

import { validatePatchStep } from "./patch-validator.js"
import { INGEST_SKILLS_DIR } from "./skill-bundle.js"

/*
 * The stage helpers run on the host here, against a real git context
 * checkout, and the T06 validator reads what they write. The ingest sandbox
 * contract test runs the same helpers inside Docker.
 */

const SOURCE_URL = "https://github.com/example-org/checkout-api"
// The source file of SOURCE_URL in the Workspace: the value of `sources`.
const SOURCE_PATH = "sources/github/example-org/checkout-api.md"

let root: string
let contextDir: string
let stepDir: string
let baseCommit: string

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  }).trim()
}

function owned(name: string, body = `# ${name}\n\nOwned prose.\n`) {
  return `---\n${stringify({
    kind: "Service",
    name,
    generated_by: "ctxpipe-extract",
    sources: [SOURCE_PATH],
  })}---\n${body}`
}

function helper(name: string, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [join(INGEST_SKILLS_DIR, "bin", name), "--root", root, ...args],
    { encoding: "utf8" },
  )
  return {
    status: result.status,
    out: `${result.stdout}${result.stderr}`,
  }
}

function ok(name: string, ...args: string[]) {
  const result = helper(name, ...args)
  expect(result.status, result.out).toBe(0)
  return result.out
}

function patch() {
  return JSON.parse(readFileSync(join(stepDir, "patch.json"), "utf8"))
}

function staged(path: string) {
  return join(stepDir, "files", path)
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function validate() {
  return validatePatchStep({
    repoDir: contextDir,
    baseCommit,
    stagedDir: stepDir,
    source: { url: SOURCE_URL, sha: "a".repeat(40) },
    sourcePath: SOURCE_PATH,
    skill: "apis",
    bundle: "ingest-0000000000000000",
    sourcePathExists: async () => true,
    readSourceFile: async () => null,
  })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "stage-helpers-"))
  contextDir = join(root, "context", "ws_fixture")
  mkdirSync(contextDir, { recursive: true })
  git(contextDir, ["init", "-q", "-b", "main"])
  write(join(contextDir, "knowledge/services/billing.md"), owned("Billing"))
  write(join(contextDir, "knowledge/services/ledger.md"), owned("Ledger"))
  write(join(contextDir, "knowledge/services/old-a.md"), owned("Old A"))
  for (let i = 0; i < 6; i++)
    write(
      join(contextDir, `knowledge/services/kept-${i}.md`),
      owned(`Kept ${i}`),
    )
  git(contextDir, ["add", "-A"])
  git(contextDir, ["commit", "-q", "-m", "base"])
  baseCommit = git(contextDir, ["rev-parse", "HEAD"])
})

beforeEach(() => {
  // Prepare empties the step output before each step.
  stepDir = join(root, "out")
  rmSync(stepDir, { recursive: true, force: true })
  mkdirSync(join(stepDir, "files"), { recursive: true })
  writeFileSync(
    join(root, "step.json"),
    JSON.stringify({ workspaceId: "ws_fixture", baseCommit }),
  )
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("stage helpers", () => {
  it("make create, update, and delete ops that the validator accepts", async () => {
    ok("ctxpipe-stage", "knowledge/services/billing.md")
    const billing = staged("knowledge/services/billing.md")
    expect(readFileSync(billing, "utf8")).toBe(owned("Billing"))
    writeFileSync(
      billing,
      owned("Billing", "# Billing\n\nThe service bills orders.\n"),
    )

    expect(ok("ctxpipe-stage", "knowledge/services/payments.md")).toContain(
      "New file",
    )
    writeFileSync(
      staged("knowledge/services/payments.md"),
      "---\nkind: Service\nname: Payments\n---\n# Payments\n\nThe service takes payments.\n",
    )

    ok("ctxpipe-delete", "knowledge/services/old-a.md", "--reason", "Gone")
    expect(ok("ctxpipe-finish")).toContain("1 create, 1 update, 1 delete")

    const blob = (path: string) =>
      git(contextDir, ["rev-parse", `${baseCommit}:${path}`])
    expect(patch()).toEqual({
      ops: [
        {
          op: "update",
          path: "knowledge/services/billing.md",
          baseBlob: blob("knowledge/services/billing.md"),
        },
        {
          op: "delete",
          path: "knowledge/services/old-a.md",
          baseBlob: blob("knowledge/services/old-a.md"),
          reason: "Gone",
        },
        { op: "create", path: "knowledge/services/payments.md" },
      ],
    })

    const result = await validate()
    expect(result.rejections).toEqual([])
    expect(result.accepted).toEqual([
      { op: "update", path: "knowledge/services/billing.md" },
      { op: "delete", path: "knowledge/services/old-a.md" },
      { op: "create", path: "knowledge/services/payments.md" },
    ])
  })

  it("make no op for a staged file that did not change", async () => {
    ok("ctxpipe-stage", "knowledge/services/ledger.md")
    ok("ctxpipe-finish")
    expect(patch()).toEqual({ ops: [] })
    const result = await validate()
    expect(result.accepted).toEqual([])
    expect(result.rejections).toEqual([])
  })

  it("keep the agent's edit when a file is staged again", () => {
    ok("ctxpipe-stage", "knowledge/services/ledger.md")
    writeFileSync(staged("knowledge/services/ledger.md"), owned("Edited"))
    expect(ok("ctxpipe-stage", "knowledge/services/ledger.md")).toContain(
      "Already staged",
    )
    expect(readFileSync(staged("knowledge/services/ledger.md"), "utf8")).toBe(
      owned("Edited"),
    )
  })

  it("accept an absolute path in the context checkout", () => {
    ok("ctxpipe-stage", join(contextDir, "knowledge/services/ledger.md"))
    expect(existsSync(staged("knowledge/services/ledger.md"))).toBe(true)
  })

  it("remove the staged copy on delete, and the delete on a new stage", () => {
    ok("ctxpipe-stage", "knowledge/services/ledger.md")
    ok("ctxpipe-delete", "knowledge/services/ledger.md", "--reason", "Merged")
    expect(existsSync(staged("knowledge/services/ledger.md"))).toBe(false)
    ok("ctxpipe-stage", "knowledge/services/ledger.md")
    ok("ctxpipe-finish")
    expect(patch()).toEqual({ ops: [] })
  })

  it("refuse a path outside the context checkout", () => {
    for (const path of ["../escape.md", "/etc/passwd", "knowledge/../.."]) {
      const result = helper("ctxpipe-stage", path)
      expect(result.status, path).toBe(1)
      expect(result.out).toMatch(/outside|not in the context/)
    }
  })

  it("refuse a delete without a reason or of a missing file", () => {
    const noReason = helper("ctxpipe-delete", "knowledge/services/ledger.md")
    expect(noReason.status).toBe(1)
    expect(noReason.out).toContain("Give a reason")
    const missing = helper(
      "ctxpipe-delete",
      "knowledge/services/none.md",
      "--reason",
      "x",
    )
    expect(missing.status).toBe(1)
    expect(missing.out).toContain("not a file in the context checkout")
  })

  it("refuse to finish when a deleted path is staged again by hand", () => {
    ok("ctxpipe-delete", "knowledge/services/ledger.md", "--reason", "Merged")
    write(staged("knowledge/services/ledger.md"), owned("Back"))
    const result = helper("ctxpipe-finish")
    expect(result.status).toBe(1)
    expect(result.out).toContain("both staged and deleted")
  })

  it("read blobs at the base commit when the checkout moved on", async () => {
    write(
      join(contextDir, "knowledge/services/billing.md"),
      owned("Billing", "# Billing\n\nA later commit.\n"),
    )
    git(contextDir, ["commit", "-q", "-am", "later"])
    try {
      ok("ctxpipe-stage", "knowledge/services/billing.md")
      expect(
        readFileSync(staged("knowledge/services/billing.md"), "utf8"),
      ).toBe(owned("Billing"))
      writeFileSync(
        staged("knowledge/services/billing.md"),
        owned("Billing", "# Billing\n\nThe service bills orders.\n"),
      )
      ok("ctxpipe-finish")
      expect(patch().ops).toEqual([
        {
          op: "update",
          path: "knowledge/services/billing.md",
          baseBlob: git(contextDir, [
            "rev-parse",
            `${baseCommit}:knowledge/services/billing.md`,
          ]),
        },
      ])
      expect((await validate()).rejections).toEqual([])
    } finally {
      git(contextDir, ["reset", "-q", "--hard", baseCommit])
    }
  })

  it("refuse a step.json without a base commit", () => {
    writeFileSync(
      join(root, "step.json"),
      JSON.stringify({ workspaceId: "ws_fixture" }),
    )
    const result = helper("ctxpipe-finish")
    expect(result.status).toBe(1)
    expect(result.out).toContain("base commit")
  })

  it("refuse to run when no step is active", () => {
    rmSync(join(root, "step.json"))
    const result = helper("ctxpipe-finish")
    expect(result.status).toBe(1)
    expect(result.out).toContain("No step is active")
  })
})
