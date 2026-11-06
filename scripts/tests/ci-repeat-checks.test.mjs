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

// The module-scope value check reads the files of the working tree, so each
// case is a git repository with no commit. The baseline is empty unless the
// case gives one.
function scan(files) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-repeat-checks-"))
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root })
    const tree = {
      "scripts/ci/module-scope-values-baseline.json": "{}",
      ...files,
    }
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    return spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../ci/check-module-scope-values.mjs", import.meta.url),
        ),
        root,
      ],
      { encoding: "utf8" },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("a new ADR that the index omits fails", () => {
  const result = run("check-adr.mjs", {
    ".ai/memory/decisions/ADR-900-tool.md": "# ADR\n",
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /list the new ADR/)
})

test("a new ADR that the index lists passes", () => {
  const result = run("check-adr.mjs", {
    ".ai/memory/decisions/ADR-900-tool.md": "# ADR\n",
    ".ai/memory/decisions/index.md": "- ADR-900-tool\n",
  })
  assert.equal(result.status, 0, result.stderr)
})

test("a renamed ADR that the index omits fails", () => {
  const result = run(
    "check-adr.mjs",
    {
      ".ai/memory/decisions/ADR-900-tool.md": null,
      ".ai/memory/decisions/ADR-901-tool.md": "# ADR\n",
    },
    {
      ".ai/memory/decisions/ADR-900-tool.md": "# ADR\n",
      ".ai/memory/decisions/index.md": "- ADR-900-tool\n",
    },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ADR-901-tool/)
})

test("a new package needs no ADR for this check", () => {
  const result = run("check-adr.mjs", {
    "packages/tool/package.json": '{"name":"tool"}\n',
  })
  assert.equal(result.status, 0, result.stderr)
})

test("a value that the file exports by name or by default is not single-use", () => {
  const result = scan({
    "apps/backend/src/a.ts": [
      `const NAMED = 1`,
      `const RENAMED = 2`,
      `const DEFAULT = "d"`,
      `export { NAMED, RENAMED as other }`,
      `export default DEFAULT`,
      ``,
    ].join("\n"),
  })
  assert.equal(result.status, 0, result.stderr)
})

test("an array or object at module scope is not flagged", () => {
  const result = scan({
    "apps/backend/src/a.ts": `const TABLE = ["a"]\nconst MAP = { a: 1 }\nexport const f = () => [TABLE, MAP]\n`,
  })
  assert.equal(result.status, 0, result.stderr)
})

test("a new module-scope value that the file reads once fails", () => {
  const result = scan({
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
  const result = scan({
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

test("a single-use value that the baseline lists passes", () => {
  const result = scan({
    "apps/backend/src/a.ts": "const OLD = 1\nexport const f = () => OLD\n",
    "scripts/ci/module-scope-values-baseline.json": JSON.stringify({
      "apps/backend/src/a.ts": ["OLD"],
    }),
  })
  assert.equal(result.status, 0, result.stderr)
})

test("a baseline entry that the files no longer have fails", () => {
  const result = scan({
    "apps/backend/src/a.ts": "export const f = () => 1\n",
    "scripts/ci/module-scope-values-baseline.json": JSON.stringify({
      "apps/backend/src/a.ts": ["OLD"],
    }),
  })
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /apps\/backend\/src\/a\.ts no longer has the single-use value `OLD`/,
  )
})

test("a tracked file that the working tree lacks is skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-repeat-checks-"))
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root })
    mkdirSync(join(root, "apps/backend/src"), { recursive: true })
    mkdirSync(join(root, "scripts/ci"), { recursive: true })
    writeFileSync(
      join(root, "scripts/ci/module-scope-values-baseline.json"),
      "{}",
    )
    writeFileSync(
      join(root, "apps/backend/src/a.ts"),
      "const ONE = 1\nexport const f = () => ONE\n",
    )
    execFileSync("git", ["add", "-A"], { cwd: root })
    rmSync(join(root, "apps/backend/src/a.ts"))
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../ci/check-module-scope-values.mjs", import.meta.url),
        ),
        root,
      ],
      { encoding: "utf8" },
    )
    assert.equal(result.status, 0, result.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
