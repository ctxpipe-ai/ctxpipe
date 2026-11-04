// Checks the changeset of a pull request (AGENTS.md "Package releases").
//
// - A change adds one `.changeset/*.md` file. A change that deletes changeset
//   files is a version PR and needs no new one.
// - A change only to tests, scripts, CI, agent files, memory, or tooling is
//   internal: every changeset that it adds is empty (two `---` lines, no
//   text), so that no `@ctxpipe/aws-cdk` release comes from it.
//
// Usage: node scripts/ci/check-changeset.mjs [repository root] [base ref]
//   (default base: origin/main)

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { changedFiles } from "./changed-files.mjs"

const internal = [
  /^(scripts|\.github|\.agents|\.claude|\.codex|\.cursor|\.ai|\.changeset|ops|examples|\.storybook)\//,
  /(^|\/)AGENTS\.md$/,
  /\.(test|spec|stories)\.[cm]?[jt]sx?$/,
  /(^|\/)(test|tests|evals)\//,
  /^(knip\.json|\.oxlintrc\.json|\.oxfmtrc\.json|\.mcp\.json|opencode\.json|\.gitignore|\.node-version)$/,
]

/** True when the changeset text has no release and no summary. */
export function isEmptyChangeset(text) {
  const match = /^---\s*\n([\s\S]*?)\n?---\s*\n?([\s\S]*)$/.exec(text)
  return match !== null && match[1].trim() === "" && match[2].trim() === ""
}

export function changesetProblems(files, readChangeset) {
  const isChangeset = (path) =>
    /^\.changeset\/(?!README\.md$)[^/]+\.md$/.test(path)
  const added = files.filter((f) => f.status === "A" && isChangeset(f.path))
  if (files.some((f) => f.status === "D" && isChangeset(f.path))) return []
  const others = files.filter((f) => !isChangeset(f.path))
  if (others.length === 0) return []
  if (added.length === 0)
    return [
      "No changeset. Add one `.changeset/<name>.md` (`pnpm changeset`). For an internal change, add an empty one: two `---` lines and no text.",
    ]
  if (others.every((f) => internal.some((pattern) => pattern.test(f.path))))
    return added
      .filter((f) => !isEmptyChangeset(readChangeset(f.path)))
      .map(
        (f) =>
          `${f.path}: this change touches only internal files, so its changeset must be empty (two \`---\` lines and no text).`,
      )
  return []
}

function main() {
  const root = resolve(process.argv[2] ?? ".")
  const base = process.argv[3] ?? "origin/main"
  const problems = changesetProblems(changedFiles(root, base), (path) =>
    readFileSync(join(root, path), "utf8"),
  )
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) process.exit(1)
  console.log("Changeset check passed.")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
