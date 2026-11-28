// Release notes by kind (ADR-020, item 7).
//
// The summary of each changeset that names a package starts with a kind tag:
// `feature: `, `improvement: ` or `fix: `. A `!` before the colon marks a
// breaking change (`fix!: `), and a major bump is breaking too.
//
// Changesets calls the changelog functions below for each entry, and it puts
// the entries under the headings of the bump (Major, Minor and Patch Changes).
// The functions keep the kind in a comment on the entry. Then `regroup`
// (run by `pnpm ci:version` after `changeset version`) puts the entries of the
// newest version of each CHANGELOG.md in the groups Features, Improvements and
// Bug fixes, with the breaking entries first.

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const groups = [
  ["feature", "Features"],
  ["improvement", "Improvements"],
  ["fix", "Bug fixes"],
]

// The kind of a changeset summary, or null when the first line has no tag.
export function parseKind(summary) {
  const match = /^(feature|improvement|fix)(!?): +/.exec(summary.trimStart())
  if (!match) return null
  return {
    kind: match[1],
    breaking: match[2] === "!",
    text: summary.trimStart().slice(match[0].length),
  }
}

function marker(kind, breaking) {
  return `<!-- kind:${kind}${breaking ? " breaking" : ""} -->`
}

function entry(prefix, text) {
  const [first, ...rest] = text.split("\n").map((line) => line.trimEnd())
  return [`- ${prefix}${first}`, ...rest.map((line) => (line ? `  ${line}` : ""))].join("\n")
}

const changelogFunctions = {
  getReleaseLine(changeset, type) {
    // The guard rejects a changeset with no kind. One that gets past it
    // goes to "Other changes", so that it does not stop a release.
    const parsed = parseKind(changeset.summary)
    const commit = changeset.commit ? `${changeset.commit.slice(0, 7)}: ` : ""
    if (!parsed) return entry(commit, changeset.summary)
    return entry(`${marker(parsed.kind, parsed.breaking || type === "major")}${commit}`, parsed.text)
  },
  getDependencyReleaseLine(changesets, dependenciesUpdated) {
    if (dependenciesUpdated.length === 0) return ""
    return [
      `- ${marker("improvement", false)}Updated dependencies`,
      ...dependenciesUpdated.map((dependency) => `  - ${dependency.name}@${dependency.newVersion}`),
    ].join("\n")
  },
}

export default changelogFunctions

// Puts the entries of the newest version of a CHANGELOG in the groups of their
// kind. A version that has no bump heading stays as it is, so a second run
// changes nothing.
export function regroup(changelog) {
  const start = changelog.search(/^## /m)
  if (start === -1) return changelog
  const nextVersion = changelog.slice(start + 3).search(/^## /m)
  const end = nextVersion === -1 ? changelog.length : start + 3 + nextVersion
  const lines = changelog.slice(start, end).trimEnd().split("\n")
  if (!lines.some((line) => /^### (Major|Minor|Patch) Changes$/.test(line))) return changelog

  const entries = []
  for (const line of lines.slice(1)) {
    if (line.startsWith("- ")) entries.push([line])
    else if (!line.startsWith("### ") && entries.length > 0) entries.at(-1).push(line)
  }
  const sorted = new Map([...groups.map(([kind]) => [kind, []]), ["other", []]])
  for (const item of entries) {
    const text = item.join("\n").trimEnd()
    const match = /^- <!-- kind:(\w+)( breaking)? -->/.exec(text)
    if (!match || !sorted.has(match[1])) {
      sorted.get("other").push({ breaking: false, text })
      continue
    }
    const body = text.slice(match[0].length)
    sorted.get(match[1]).push({
      breaking: Boolean(match[2]),
      text: `- ${match[2] ? "**Breaking:** " : ""}${body}`,
    })
  }

  const sections = [...groups, ["other", "Other changes"]]
    .map(([kind, heading]) => {
      const items = sorted.get(kind)
      if (items.length === 0) return null
      const ordered = [...items.filter((item) => item.breaking), ...items.filter((item) => !item.breaking)]
      // A multi-line entry has a blank line after it, as Changesets writes it.
      const body = ordered
        .map((item, index) => (item.text.includes("\n") && index < ordered.length - 1 ? `${item.text}\n` : item.text))
        .join("\n")
      return `### ${heading}\n\n${body}`
    })
    .filter(Boolean)
  const section = [lines[0], ...sections].join("\n\n")
  return `${changelog.slice(0, start)}${section}\n${end < changelog.length ? `\n${changelog.slice(end)}` : ""}`
}

// `node scripts/release/changelog.mjs [root]` regroups CHANGELOG.md of each
// package under packages/.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const packages = join(process.argv[2] ?? process.cwd(), "packages")
  for (const name of readdirSync(packages)) {
    const file = join(packages, name, "CHANGELOG.md")
    let text
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    const grouped = regroup(text)
    if (grouped !== text) writeFileSync(file, grouped)
  }
}
