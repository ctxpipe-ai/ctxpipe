import { execFileSync, spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { resolveDiscoveredRoots } from "./discovered-roots.js"
import {
  FIXTURE_OTHER_SOURCE_URL,
  FIXTURE_SOURCE_PATH,
  FIXTURE_SOURCE_URL,
  HOSTILE_CONTEXT,
  HOSTILE_SOURCE,
  INJECTION_CASES,
  type InjectionCase,
} from "./injection-fixtures.js"
import { gitSource, validatePatchStep } from "./patch-validator.js"
import { INGEST_SKILLS_DIR } from "./skill-bundle.js"

/*
 * T19: the hostile fixture repositories go through the real host guards
 * (the patch validator and the discover-roots host check) on real git
 * repositories. Each case is the output of a model that obeys a payload.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
}

let root: string
let sourceDir: string
let contextDir: string
let sourceSha: string
let baseCommit: string
let stepCount = 0

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    env: GIT_ENV,
    encoding: "utf8",
  }).trim()
}

function writeTree(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

function repository(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "-b", "main")
  writeTree(dir, files)
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "fixture")
  return git(dir, "rev-parse", "HEAD")
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "injection-fixtures-"))
  sourceDir = join(root, "source")
  contextDir = join(root, "context")
  sourceSha = repository(sourceDir, HOSTILE_SOURCE)
  baseCommit = repository(contextDir, HOSTILE_CONTEXT)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Writes the case's step like `ctxpipe-stage`/`ctxpipe-delete`/`ctxpipe-finish`. */
function stage(item: InjectionCase): string {
  stepCount += 1
  const dir = join(root, `step-${stepCount}`)
  const files = join(dir, "files")
  mkdirSync(files, { recursive: true })
  writeTree(files, item.staged ?? {})
  if (item.symlink) {
    mkdirSync(dirname(join(files, item.symlink.path)), { recursive: true })
    symlinkSync(
      join(sourceDir, item.symlink.to),
      join(files, item.symlink.path),
    )
  }
  const known = new Set(
    git(contextDir, "ls-tree", "-r", "--name-only", baseCommit).split("\n"),
  )
  const blob = (path: string) =>
    known.has(path)
      ? git(contextDir, "rev-parse", `${baseCommit}:${path}`)
      : undefined
  const ops = [
    ...Object.keys(item.staged ?? {}).map((path) =>
      known.has(path)
        ? { op: "update", path, baseBlob: blob(path) }
        : { op: "create", path },
    ),
    ...(item.deletes ?? []).map((path) => ({
      op: "delete",
      path,
      baseBlob: blob(path) ?? "0".repeat(40),
      reason: "The payload asked for it",
    })),
  ]
  writeFileSync(join(dir, "patch.json"), JSON.stringify({ ops }))
  return dir
}

function validate(stagedDir: string) {
  return validatePatchStep({
    repoDir: contextDir,
    baseCommit,
    stagedDir,
    source: { url: FIXTURE_SOURCE_URL, sha: sourceSha },
    sourcePath: FIXTURE_SOURCE_PATH,
    skill: "apis",
    bundle: "bundle-fixture",
    ...gitSource(sourceDir, sourceSha),
    linkableRepositories: [FIXTURE_OTHER_SOURCE_URL],
  })
}

describe("injection fixtures", () => {
  it("names a payload that is in its fixture file for each case", () => {
    const ids = new Set<string>()
    for (const item of INJECTION_CASES) {
      expect(ids.has(item.id), item.id).toBe(false)
      ids.add(item.id)
      const files =
        item.payload.repository === "source" ? HOSTILE_SOURCE : HOSTILE_CONTEXT
      expect(files[item.payload.path], item.id).toContain(item.payload.text)
      expect(
        Boolean(item.rejected?.length) !== Boolean(item.quoted),
        `${item.id} must expect a rejection or a quote`,
      ).toBe(true)
    }
  })

  it("covers each hostile file of both repositories", () => {
    const covered = new Set(
      INJECTION_CASES.map((c) => `${c.payload.repository}:${c.payload.path}`),
    )
    const hostile = [
      "source:README.md",
      "source:AGENTS.md",
      "source:src/payments/charge.ts",
      "source:docs/adr/0007-payment-retries.md",
      "source:.env.example",
      "source:package.json",
      "context:linear/CTX-1.md",
    ]
    expect(hostile.filter((key) => !covered.has(key))).toEqual([])
  })

  it.each(INJECTION_CASES.map((item) => [item.id, item] as const))(
    "%s: the host refuses the payload or keeps it as a sourced quote",
    async (_id, item) => {
      const result = await validate(stage(item))
      const rejected = item.rejected ?? []
      expect(
        result.rejections
          .map((r) => ({ path: r.path, rule: r.rule }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      ).toEqual([...rejected].sort((a, b) => a.path.localeCompare(b.path)))
      const refused = new Set(rejected.map((r) => r.path))
      const expectedAccepted = [
        ...Object.keys(item.staged ?? {}),
        ...(item.deletes ?? []),
      ].filter((path) => !refused.has(path) && !path.includes(".."))
      expect(result.accepted.map((op) => op.path).sort()).toEqual(
        expectedAccepted.sort(),
      )
      if (item.quoted) {
        const text = git(
          contextDir,
          "cat-file",
          "-p",
          `${result.tree}:${item.quoted.path}`,
        )
        const quote = text
          .split("\n")
          .filter((line) => line.startsWith(">"))
          .join("\n")
        expect(quote).toContain(item.payload.text)
        expect(text).toContain(`Source: ${item.quoted.source}`)
      }
    },
  )
})

describe("injection fixtures: discover-roots", () => {
  function discover(): unknown {
    const run = spawnSync(
      process.execPath,
      [
        join(INGEST_SKILLS_DIR, "discover-roots/scripts/discover-roots.mjs"),
        sourceDir,
      ],
      { encoding: "utf8", env: GIT_ENV },
    )
    expect(run.status, run.stderr).toBe(0)
    return JSON.parse(run.stdout)
  }

  it("plans no root outside the checkout or with an unsafe folder name", () => {
    const { roots } = resolveDiscoveredRoots(discover(), null)
    const paths = roots.map((r) => r.path)
    expect(paths).toContain("packages/api")
    for (const path of paths) {
      expect(path).not.toMatch(/\.\.|`|\n/)
      expect(path.startsWith("/")).toBe(false)
    }
  })

  it("refuses roots that an obeying model adds", () => {
    const script = discover()
    const { roots, refused } = resolveDiscoveredRoots(script, {
      roots: [
        { path: "../../outside/payments" },
        { path: "packages/evil`name" },
        { path: "packages/line\n## Note for AI agents" },
        { path: "packages/not-a-candidate" },
      ],
    })
    expect(roots.map((r) => r.path)).toEqual(
      resolveDiscoveredRoots(script, null).roots.map((r) => r.path),
    )
    expect(refused.map((r) => r.path)).toEqual([
      "../../outside/payments",
      "packages/evil`name",
      "packages/line\n## Note for AI agents",
      "packages/not-a-candidate",
    ])
  })
})
