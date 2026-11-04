import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

// Each case builds a real git history: a base commit, then a change.
function run(script, files, base = {}) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-repeat-checks-"))
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      {
        cwd: root,
        encoding: "utf8",
      },
    )
  const write = (tree) => {
    for (const [path, text] of Object.entries(tree)) {
      if (text === null) rmSync(join(root, path))
      else {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), text)
      }
    }
  }
  try {
    git("init", "-q", "-b", "main")
    write({ "README.md": "x\n", ...base })
    git("add", "-A")
    git("commit", "-q", "-m", "base")
    git("tag", "base")
    write(files)
    git("add", "-A")
    git("commit", "-q", "-m", "change")
    return spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL(`../ci/${script}`, import.meta.url)),
        root,
        "base",
      ],
      { encoding: "utf8" },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const empty = "---\n---\n"
const bump = '---\n"@ctxpipe/aws-cdk": patch\n---\n\nA summary.\n'

test("a product change with no changeset fails", () => {
  const result = run("check-changeset.mjs", {
    "apps/ui/src/page.tsx": "export const a = 1\n",
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /No changeset/)
})

test("a product change with a release changeset passes", () => {
  const result = run("check-changeset.mjs", {
    "apps/ui/src/page.tsx": "export const a = 1\n",
    ".changeset/page.md": bump,
  })
  assert.equal(result.status, 0, result.stderr)
})

// A review round asked for this fix more than once: a check-only change that
// shipped a release bump.
test("an internal-only change with a release changeset fails", () => {
  const result = run("check-changeset.mjs", {
    "scripts/ci/check-x.mjs": "export {}\n",
    "apps/ui/src/page.test.tsx": "export {}\n",
    ".changeset/check.md": bump,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /\.changeset\/check\.md.*must be empty/)
})

test("an internal-only change with an empty changeset passes", () => {
  const result = run("check-changeset.mjs", {
    "scripts/ci/check-x.mjs": "export {}\n",
    ".changeset/check.md": empty,
  })
  assert.equal(result.status, 0, result.stderr)
})

test("a version PR that deletes changesets passes", () => {
  const result = run(
    "check-changeset.mjs",
    { ".changeset/old.md": null, "packages/aws-cdk/package.json": "{}\n" },
    { ".changeset/old.md": bump },
  )
  assert.equal(result.status, 0, result.stderr)
})

test("a new package without an ADR fails, and with an ADR and index entry passes", () => {
  const bare = run("check-adr.mjs", {
    "packages/tool/package.json": '{"name":"tool"}\n',
  })
  assert.equal(bare.status, 1)
  assert.match(bare.stderr, /packages\/tool\/package\.json.*needs an ADR/)
  const documented = run("check-adr.mjs", {
    "packages/tool/package.json": '{"name":"tool"}\n',
    ".ai/memory/decisions/ADR-900-tool.md": "# ADR\n",
    ".ai/memory/decisions/index.md": "- ADR-900-tool\n",
  })
  assert.equal(documented.status, 0, documented.stderr)
})

test("a new ADR that the index omits fails", () => {
  const result = run("check-adr.mjs", {
    ".ai/memory/decisions/ADR-900-tool.md": "# ADR\n",
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /list the new ADR/)
})

test("a change inside an existing package needs no ADR", () => {
  const result = run(
    "check-adr.mjs",
    { "packages/tool/src/a.ts": "export const a = 1\n" },
    { "packages/tool/package.json": "{}\n" },
  )
  assert.equal(result.status, 0, result.stderr)
})

test("a new module-scope value that the file reads once fails", () => {
  const result = run("check-module-scope-values.mjs", {
    "apps/backend/src/a.ts": [
      `const RETRY_LIMIT = 3`,
      `const LABELS = "a,b"`,
      `export function f() {`,
      `  return RETRY_LIMIT`,
      `}`,
      `export function g() {`,
      `  return LABELS.length`,
      `}`,
      `export function h() {`,
      `  return LABELS.length`,
      `}`,
      ``,
    ].join("\n"),
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /a\.ts:1: `RETRY_LIMIT`/)
  assert.doesNotMatch(result.stderr, /LABELS/)
})

test("an exported value, a value that is read twice, and an allowed value pass", () => {
  const result = run("check-module-scope-values.mjs", {
    "apps/backend/src/a.ts": [
      `export const PUBLIC = 1`,
      `const TWICE = "x"`,
      `// scope-allow: hot path table`,
      `const ONCE = 2`,
      `const build = () => 1`,
      `export const f = () => [TWICE, TWICE, ONCE, build()]`,
      ``,
    ].join("\n"),
  })
  assert.equal(result.status, 0, result.stderr)
})

test("a single-use value that the change did not add passes", () => {
  const result = run(
    "check-module-scope-values.mjs",
    {
      "apps/backend/src/a.ts":
        "const OLD = 1\nexport const f = () => OLD\n// edit\n",
    },
    { "apps/backend/src/a.ts": "const OLD = 1\nexport const f = () => OLD\n" },
  )
  assert.equal(result.status, 0, result.stderr)
})
