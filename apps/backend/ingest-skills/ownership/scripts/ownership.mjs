#!/usr/bin/env node
// ownership: read CODEOWNERS and write one knowledge/teams/<team>.md file for
// each GitHub team that owns a root. A team file has an OWNS claim to each
// context file of a root that it owns. A file that already describes the team
// gets new claims and Related lines. No model runs.
//
// The context file of a root is a file in knowledge/{services,apps,libraries}/
// with a claim whose evidence is a package manifest of that root.
//
// node ownership.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> [--roots <discover-roots result>]

import { execFileSync } from "node:child_process"
import {
  findExisting,
  newFile,
  relativeTo,
  scriptStep,
  slug,
  writeStep,
} from "../../bin/knowledge-lib.mjs"
import {
  readTracked,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"

/** GitHub reads CODEOWNERS from these places, in this order. */
const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]
const SAFE_PATTERN = /^[A-Za-z0-9_./*?!@[\]{}-]{1,200}$/
const TEAM =
  /^@([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/
const PERSON = /^@[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const EMAIL = /^[^@\s]+@[^@\s]+$/

const { step, source, repository, roots, index } = scriptStep()
const files = new Set(trackedFiles(source))
const codeowners = CODEOWNERS_PATHS.find((p) => files.has(p))
const skipped = []

function globRegex(glob) {
  let out = ""
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === "*" && glob[i + 1] === "*") {
      out += ".*"
      i++
    } else if (ch === "*") out += "[^/]*"
    else if (ch === "?") out += "[^/]"
    else if (/[.+^$()|[\]{}\\]/.test(ch)) out += `\\${ch}`
    else out += ch
  }
  return new RegExp(`^${out}$`)
}

/**
 * True when a CODEOWNERS pattern covers the folder of a root. A file glob
 * (`*.md`, `docs/*.md`) never owns a root. `*` covers each root.
 */
function covers(pattern, root) {
  let glob = pattern
  if (["*", "/", "**", "/**"].includes(glob)) return true
  if (root === ".") return false
  const anchored = glob.startsWith("/")
  glob = glob
    .replace(/^\//, "")
    .replace(/\/\*\*$/, "")
    .replace(/\/$/, "")
  if (glob === "") return true
  const last = glob.split("/").at(-1)
  if (last !== "**" && /\.[A-Za-z0-9]+$/.test(last)) return false
  const re = globRegex(glob)
  const parts = root.split("/")
  const ancestors = parts.map((_, i) => parts.slice(0, i + 1).join("/"))
  if (anchored) return ancestors.some((a) => re.test(a))
  return ancestors.some((a) => {
    const segments = a.split("/")
    return segments.some((_, s) => re.test(segments.slice(s).join("/")))
  })
}

function rules(text) {
  const out = []
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim()
    if (!line) return
    const [pattern, ...owners] = line.split(/\s+/)
    if (!SAFE_PATTERN.test(pattern)) {
      skipped.push({
        path: codeowners,
        reason: `Line ${i + 1} has a pattern that the script does not quote`,
      })
      return
    }
    const teams = []
    for (const owner of owners) {
      const team = TEAM.exec(owner)
      if (team) teams.push({ org: team[1], name: team[2] })
      else if (!PERSON.test(owner) && !EMAIL.test(owner)) {
        skipped.push({
          path: codeowners,
          reason: `Line ${i + 1} has an owner that the script does not quote`,
        })
        return
      }
    }
    // A rule with no team still takes ownership from earlier rules.
    out.push({ pattern, teams })
  })
  return out
}

/** Context files in a kind folder, keyed by the manifest paths that their claims cite. */
function rootFiles() {
  const byEvidence = new Map()
  const git = (args, input) =>
    execFileSync("git", ["-C", step.contextDir, ...args], {
      input,
      maxBuffer: 256 * 1024 * 1024,
    }).toString("utf8")
  const paths = git([
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    step.baseCommit,
    "--",
    "knowledge/services",
    "knowledge/apps",
    "knowledge/libraries",
  ])
    .split("\0")
    .filter((p) => p.endsWith(".md"))
    .sort()
  for (const path of paths) {
    const text = git(["show", `${step.baseCommit}:${path}`])
    const front = /^---[ \t]*\r?\n((?:.*\n)*?)---/.exec(text)
    if (!front) continue
    for (const m of front[1].matchAll(/^\s*path:\s*["']?([^"'\s]+)["']?\s*$/gm))
      if (!byEvidence.has(m[1])) byEvidence.set(m[1], path)
  }
  return byEvidence
}

const plans = []
if (codeowners) {
  const parsed = rules(readTracked(source, codeowners))
  const byEvidence = rootFiles()
  const teams = new Map()
  for (const root of roots) {
    let owner = null
    for (const rule of parsed) if (covers(rule.pattern, root.path)) owner = rule
    if (!owner) continue
    const dir = root.path === "." ? "" : `${root.path}/`
    const target = root.manifests
      .map((m) => byEvidence.get(`${dir}${m}`))
      .find(Boolean)
    for (const team of owner.teams) {
      const key = `${team.org}/${team.name}`
      const entry = teams.get(key) ?? { team, roots: [] }
      entry.roots.push({ root: root.path, pattern: owner.pattern, target })
      teams.set(key, entry)
    }
  }
  for (const [key, { team, roots: owned }] of teams) {
    const path =
      findExisting(index, "Team", [key]) ??
      `knowledge/teams/${slug(team.name)}.md`
    const claims = owned
      .filter((o) => o.target)
      .map((o) => ({
        to: relativeTo(path, o.target),
        predicate: "OWNS",
        evidence: { path: codeowners, kind: "script" },
      }))
    const related = owned
      .map(
        (o) =>
          `- Owns \`${o.root}\` in \`${repository}\` (\`${codeowners}\`: \`${o.pattern}\`)`,
      )
      .sort()
    plans.push({
      path,
      claims,
      related,
      create: () =>
        newFile({
          kind: "Team",
          name: key,
          summary: `GitHub team @${key}.`,
          intro: `The GitHub team \`@${key}\`. The CODEOWNERS file of a source repository names it as an owner.`,
          claims,
          related,
        }),
    })
  }
}

writeStep(step, plans, skipped)
