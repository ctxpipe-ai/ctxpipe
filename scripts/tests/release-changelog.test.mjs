import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { changesetProblem } from "../release/check-changeset-kinds.mjs"

const root = fileURLToPath(new URL("../..", import.meta.url))

// A workspace with one package and the repo's changeset config, changelog
// module and `ci:version` script. Then the real `changeset version` runs.
function version(changesets, changelog = "# @fixture/a\n") {
  const dir = mkdtempSync(join(tmpdir(), "changelog-kinds-"))
  const rootScripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", private: true }),
  )
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")
  mkdirSync(join(dir, "packages/a"), { recursive: true })
  writeFileSync(join(dir, "packages/a/package.json"), JSON.stringify({ name: "@fixture/a", version: "1.0.0" }))
  writeFileSync(join(dir, "packages/a/CHANGELOG.md"), changelog)
  mkdirSync(join(dir, ".changeset"))
  const config = JSON.parse(readFileSync(join(root, ".changeset/config.json"), "utf8"))
  writeFileSync(join(dir, ".changeset/config.json"), JSON.stringify({ ...config, ignore: [] }))
  cpSync(join(root, "scripts/release"), join(dir, "scripts/release"), { recursive: true })
  for (const [id, text] of Object.entries(changesets)) writeFileSync(join(dir, `.changeset/${id}.md`), text)
  const result = spawnSync("sh", ["-c", rootScripts["ci:version"]], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(root, "node_modules/.bin")}${delimiter}${process.env.PATH}` },
  })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  return readFileSync(join(dir, "packages/a/CHANGELOG.md"), "utf8")
}

test("changeset version writes the entries of a version in groups by kind, breaking first", () => {
  const changelog = version({
    "add-x": '---\n"@fixture/a": minor\n---\n\nfeature: Add the `x` prop.\n',
    "fix-y": '---\n"@fixture/a": patch\n---\n\nfix: The `y` prop works again.\n',
    "drop-z": '---\n"@fixture/a": patch\n---\n\nimprovement!: Remove the `z` prop.\n\nUpgrade: use `x`.\n',
    "faster-w": '---\n"@fixture/a": patch\n---\n\nimprovement: Synth is faster.\n',
  })
  assert.equal(
    changelog,
    [
      "# @fixture/a",
      "",
      "## 1.1.0",
      "",
      "### Features",
      "",
      "- Add the `x` prop.",
      "",
      "### Improvements",
      "",
      "- **Breaking:** Remove the `z` prop.",
      "",
      "  Upgrade: use `x`.",
      "",
      "- Synth is faster.",
      "",
      "### Bug fixes",
      "",
      "- The `y` prop works again.",
      "",
    ].join("\n"),
  )
})

test("a major bump is breaking, the older versions stay as they are, and a changeset with no kind is kept", () => {
  const older = "## 1.0.0\n\n### Major Changes\n\n- abc1234: First release.\n"
  const changelog = version(
    {
      "big-fix": '---\n"@fixture/a": major\n---\n\nfix: The default changes.\n',
      "no-kind": '---\n"@fixture/a": patch\n---\n\nSomething old.\n',
    },
    `# @fixture/a\n\n${older}`,
  )
  assert.equal(
    changelog,
    `# @fixture/a\n\n## 2.0.0\n\n### Bug fixes\n\n- **Breaking:** The default changes.\n\n### Other changes\n\n- Something old.\n\n${older}`,
  )
})

test("the guard rejects a changeset that names a package and has no kind", () => {
  assert.equal(changesetProblem("---\n---\n"), null)
  assert.equal(changesetProblem("---\n---\n\nAn internal note.\n"), null)
  assert.equal(changesetProblem('---\n"ctxpipe": patch\n---\n\nfix: The CLI works.\n'), null)
  assert.equal(changesetProblem('---\n"ctxpipe": minor\n---\n\nfeature!: New flags.\n'), null)
  assert.match(changesetProblem('---\n"ctxpipe": patch\n---\n\nThe CLI works.\n'), /no kind/)
  assert.match(changesetProblem('---\n"ctxpipe": patch\n---\n\nFix: The CLI works.\n'), /no kind/)
  assert.match(changesetProblem("no front matter\n"), /no front matter/)
})

test("the guard command fails for a file with no kind and passes for valid files", () => {
  const dir = mkdtempSync(join(tmpdir(), "changeset-guard-"))
  writeFileSync(join(dir, "good.md"), '---\n"ctxpipe": patch\n---\n\nfix: Works.\n')
  writeFileSync(join(dir, "empty.md"), "---\n---\n")
  writeFileSync(join(dir, "bad.md"), '---\n"ctxpipe": patch\n---\n\nWorks.\n')
  const run = (...files) =>
    spawnSync(process.execPath, [join(root, "scripts/release/check-changeset-kinds.mjs"), ...files.map((f) => join(dir, f))], {
      encoding: "utf8",
    })
  assert.equal(run("good.md", "empty.md").status, 0)
  const failed = run("good.md", "bad.md")
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /bad\.md names a package but has no kind/)
})
