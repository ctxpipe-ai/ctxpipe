// The OWNERS files of the Kubernetes owners model (https://go.k8s.io/owners)
// for the ownership skill (CTX-1513). An `OWNERS` file in a folder lists the
// approvers and reviewers of that folder. `OWNERS_ALIASES` at the repository
// top gives a name to a group of people. Each alias that an OWNERS file names
// is a team: the script writes one Team file for it. A person is not a team.
//
// The nearest OWNERS file at or above a root that has approvers gives the
// owners of the root. When its approvers include an alias, each such alias
// gets an OWNS claim to each file of the root. When its approvers are only
// people, no team owns the root. `options.no_parent_owners` stops the walk.

import { posix } from "node:path"

import { relativeTo } from "../../bin/knowledge-lib.mjs"
import {
  ignoredFolder,
  readTracked,
} from "../../discover-roots/scripts/roots-lib.mjs"

const ALIASES_FILE = "OWNERS_ALIASES"
const OWNERS_FILE = /(?:^|\/)OWNERS$/
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/
/**
 * The Related lines of one new team file stay below this size, so the file
 * stays below the 64 KiB limit of the host validator. The lines that do not
 * fit go to `skipped`.
 */
const MAX_TEAM_LINE_BYTES = 48 * 1024

/** The text of a YAML line before its comment, outside quotes. */
function withoutComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote === '"' && c === "\\") i++
    else if (quote && c === quote) quote = null
    else if (!quote && (c === '"' || c === "'")) quote = c
    else if (!quote && c === "#" && (i === 0 || /\s/.test(line[i - 1])))
      return line.slice(0, i).trimEnd()
  }
  return line.trimEnd()
}

/** A plain or quoted YAML scalar on one line, or null. */
function scalar(text) {
  const value = text.trim()
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value)
      return typeof parsed === "string" ? parsed : null
    } catch {
      return null
    }
  }
  if (value.startsWith("'"))
    return /^'(?:[^']|'')*'$/.test(value)
      ? value.slice(1, -1).replaceAll("''", "'")
      : null
  if (/^[[\]{}|>&*!%@`]/.test(value) || /:(?:\s|$)/.test(value)) return null
  return value
}

/**
 * The YAML subset of OWNERS files: nested maps, and lists of scalars in
 * block or flow form. The sandbox has no YAML parser. Null when the text
 * has another form, so the script never guesses an owner.
 */
export function readOwnersYaml(text) {
  const top = Object.create(null)
  // A frame is a key whose value the deeper lines give.
  const frames = [{ indent: -1, holder: { value: top }, key: "value" }]
  const valueOf = (frame) => frame.holder[frame.key]
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || raw.trim() === "") continue
    if (/^ *\t/.test(raw)) return null
    const indent = raw.length - raw.trimStart().length
    const line = withoutComment(raw.trim())
    if (line === "") continue
    const item = /^-(?:\s+(.*))?$/.exec(line)
    while (frames.length > 1) {
      const frame = frames.at(-1)
      if (frame.indent < indent) break
      // A list item can be at the indent of its key.
      const value = valueOf(frame)
      if (
        item &&
        frame.indent === indent &&
        (value === null || Array.isArray(value))
      )
        break
      frames.pop()
    }
    const frame = frames.at(-1)
    if (item) {
      let list = valueOf(frame)
      if (list === null) {
        list = []
        frame.holder[frame.key] = list
      }
      if (!Array.isArray(list)) return null
      const value = scalar(item[1] ?? "")
      if (value === null) return null
      list.push(value)
      continue
    }
    const pair =
      /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#:][^:]*?)\s*:(?:\s+(.*))?$/.exec(
        line,
      )
    if (!pair) return null
    let map = valueOf(frame)
    if (map === null) {
      map = Object.create(null)
      frame.holder[frame.key] = map
    }
    if (typeof map !== "object" || Array.isArray(map)) return null
    const key = scalar(pair[1])
    if (key === null) return null
    const rest = pair[2]?.trim() ?? ""
    if (rest === "") {
      map[key] = null
      frames.push({ indent, holder: map, key })
    } else if (rest.startsWith("[")) {
      if (!rest.endsWith("]")) return null
      const items = rest.slice(1, -1).trim()
      const values = items === "" ? [] : items.split(",").map(scalar)
      if (values.includes(null)) return null
      map[key] = values
    } else {
      const value = scalar(rest)
      if (value === null) return null
      map[key] = value
    }
  }
  return top
}

const list = (value) =>
  Array.isArray(value) ? value.filter((v) => typeof v === "string") : []
const map = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null

/**
 * The approvers and reviewers of an OWNERS file: the top level and the
 * filter `.*`, which applies to each file. `filtered` holds each other
 * filter, which applies only to the files that its pattern matches.
 */
function ownersOf(yaml) {
  const filters = map(yaml.filters) ?? Object.create(null)
  const all = map(filters[".*"]) ?? Object.create(null)
  const options = map(yaml.options)
  return {
    approvers: [...new Set([...list(yaml.approvers), ...list(all.approvers)])],
    reviewers: [...new Set([...list(yaml.reviewers), ...list(all.reviewers)])],
    filtered: Object.entries(filters)
      .filter(([pattern]) => pattern !== ".*")
      .map(([pattern, value]) => ({
        pattern,
        approvers: list(map(value)?.approvers),
        reviewers: list(map(value)?.reviewers),
      })),
    noParent: String(options?.no_parent_owners) === "true",
  }
}

/** A file-name part: lower case letters and digits, with `-` between. */
export const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const folderOf = (file) => {
  const dir = posix.dirname(file)
  return dir === "" ? "." : dir
}
const where = (dir) => (dir === "." ? "the repository top" : `\`${dir}\``)

/**
 * The plans of the Team files of the OWNERS aliases, for `writeStep`. Each
 * entry of `skipped` names a file that the script could not read, a name
 * that it does not quote, or lines that did not fit in a team file.
 */
export function ownersPlans({ source, files, repository, roots, index }) {
  const skipped = []
  if (!files.has(ALIASES_FILE)) return { plans: [], skipped }
  const aliasesYaml = readOwnersYaml(readTracked(source, ALIASES_FILE))
  const aliases = new Map()
  if (!aliasesYaml) {
    skipped.push({
      path: ALIASES_FILE,
      reason: "The script cannot read the YAML of the file",
    })
    return { plans: [], skipped }
  }
  for (const [name, members] of Object.entries(
    map(aliasesYaml.aliases) ?? {},
  )) {
    if (!SAFE_NAME.test(name)) {
      skipped.push({
        path: ALIASES_FILE,
        reason: "An alias has a name that the script does not quote",
      })
      continue
    }
    aliases.set(
      name,
      list(members).filter((m) => SAFE_NAME.test(m)),
    )
  }

  // The OWNERS files by folder. Vendored and test-data folders hold the
  // OWNERS files of other projects, so the script does not read them.
  const owners = new Map()
  for (const file of [...files].filter((f) => OWNERS_FILE.test(f)).sort()) {
    const dir = folderOf(file)
    if (ignoredFolder(dir)) continue
    const yaml = readOwnersYaml(readTracked(source, file))
    if (!yaml) {
      skipped.push({
        path: file,
        reason: "The script cannot read the YAML of the file",
      })
      continue
    }
    owners.set(dir, { file, ...ownersOf(yaml) })
  }

  const teams = new Map()
  const team = (alias) => {
    if (!teams.has(alias)) teams.set(alias, { lines: [], claims: [] })
    return teams.get(alias)
  }
  for (const [dir, entry] of owners) {
    for (const [role, names] of [
      ["Approves", entry.approvers],
      ["Reviews", entry.reviewers],
    ])
      for (const alias of names.filter((n) => aliases.has(n)))
        team(alias).lines.push(
          `- ${role} ${where(dir)} in \`${repository}\` (\`${entry.file}\`)`,
        )
    // A filter applies only to the files that its pattern matches, so its
    // aliases get a line with the pattern and no OWNS claim.
    for (const filter of entry.filtered) {
      const names = [...filter.approvers, ...filter.reviewers]
      if (!names.some((n) => aliases.has(n))) continue
      if (/[`\r\n]/.test(filter.pattern)) {
        skipped.push({
          path: entry.file,
          reason: "A filter has a pattern that the script does not quote",
        })
        continue
      }
      for (const [role, names] of [
        ["Approves", filter.approvers],
        ["Reviews", filter.reviewers],
      ])
        for (const alias of names.filter((n) => aliases.has(n)))
          team(alias).lines.push(
            `- ${role} the files that match \`${filter.pattern}\` in ${where(dir)} in \`${repository}\` (\`${entry.file}\`)`,
          )
    }
  }

  for (const root of roots) {
    // The approvers of each OWNERS file at or above the root folder apply,
    // as in Kubernetes: a file with `no_parent_owners` stops the walk. An
    // alias gets its claims from the nearest file that names it.
    const found = new Map()
    for (let dir = root.path; ; dir = folderOf(dir)) {
      const entry = owners.get(dir)
      for (const alias of entry?.approvers ?? [])
        if (aliases.has(alias) && !found.has(alias)) found.set(alias, entry)
      if (entry?.noParent || dir === ".") break
    }
    for (const [alias, entry] of found) {
      const owned = team(alias)
      owned.lines.push(
        `- Owns ${where(root.path)} in \`${repository}\` (\`${entry.file}\`)`,
      )
      owned.claims.push(
        ...root.files.map((file) => ({
          file: file.path,
          evidence: entry.file,
        })),
      )
    }
  }

  const plans = []
  for (const alias of [...teams.keys()].sort()) {
    const { lines, claims } = teams.get(alias)
    const name = `${repository}/${alias}`
    const existing =
      index
        .filter(
          (e) =>
            e.kind === "Team" &&
            typeof e.title === "string" &&
            e.title.toLowerCase() === name.toLowerCase(),
        )
        .map((e) => e.path)
        .sort()[0] ?? null
    const path =
      existing ?? `knowledge/teams/${slug(repository)}-${slug(alias)}.md`
    // Keep the lines that fit, in order, and record the rest.
    const kept = []
    let bytes = 0
    for (const line of [...new Set(lines)].sort()) {
      bytes += Buffer.byteLength(line) + 1
      if (bytes > MAX_TEAM_LINE_BYTES) break
      kept.push(line)
    }
    const cut = new Set(lines).size - kept.length
    if (cut)
      skipped.push({
        path,
        reason: `${cut} Related lines of the team did not fit in ${MAX_TEAM_LINE_BYTES / 1024} KiB`,
      })
    const members = aliases.get(alias)
    plans.push({
      path,
      expectName: name,
      exactName: true,
      claims: claims.map((c) => ({
        to: relativeTo(path, c.file),
        predicate: "OWNS",
        evidence: { path: c.evidence, kind: "script" },
      })),
      related: kept,
      create: {
        kind: "Team",
        name,
        summary: `The OWNERS alias ${alias} of the ${repository} repository: ${members.length} people who approve or review its folders.`,
        intro: [
          `The alias \`${alias}\` of \`${ALIASES_FILE}\` in \`${repository}\`. Its OWNERS files name it as an approver or a reviewer of a folder.`,
          members.length
            ? `Members: ${members.map((m) => `\`@${m}\``).join(", ")}.`
            : "The alias has no members.",
        ].join("\n\n"),
      },
    })
  }
  return { plans, skipped }
}
