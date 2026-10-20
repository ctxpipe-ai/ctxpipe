#!/usr/bin/env node
// ownership: a repository-wide step on the assembled ref, after the root
// steps. It reads CODEOWNERS and writes one knowledge/teams/<org>-<team>.md
// file for each GitHub team that owns a root. A team file has an OWNS claim
// to each file of the root in the host's root-to-file map. A file that
// already describes the team gets new claims and Related lines. No model
// runs. A step writes at most 30 files; the host runs it again while the
// result has `more: true`.
//
// node ownership.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --source-path <path> --roots <root-to-file map>

import { relativeTo, scriptStep, writeStep } from "../../bin/knowledge-lib.mjs"
import {
  globMatcher,
  MAX_DEPTH,
  matchBudgetLeft,
  readTracked,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"

/** GitHub reads CODEOWNERS from these places, in this order. */
const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]
const MAX_RULES = 2000
const SAFE_PATTERN = /^[A-Za-z0-9_./*?!@[\]{}-]{1,200}$/
const TEAM =
  /^@([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/
const PERSON = /^@[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const EMAIL = /^[^@\s]+@[^@\s]+$/

const { step, source, repository, roots, index, skipped } = scriptStep()
const files = new Set(trackedFiles(source))
const codeowners = CODEOWNERS_PATHS.find((p) => files.has(p))

const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

/** Patterns that cover the repository root itself (each file of the repository). */
const WHOLE_REPOSITORY = new Set(["*", "/*", "/", "**", "/**"])

/**
 * The rules of a CODEOWNERS file in order. A rule is
 * { pattern, teams, matches }. A rule that the script cannot quote stays as
 * a rule with no team, so an earlier broader rule does not take its roots.
 * A rule whose pattern the script cannot match matches each root, with
 * `unknown` set, so its roots have no owner and are skipped.
 */
function rules(text) {
  const out = []
  const lines = text.split("\n")
  if (lines.length > MAX_RULES)
    skipped.push({
      path: codeowners,
      reason: `The script read only the first ${MAX_RULES} lines of the file`,
    })
  lines.slice(0, MAX_RULES).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim()
    if (!line) return
    const [pattern, ...owners] = line.split(/\s+/)
    const matcher = globMatcher(pattern, { codeowners: true })
    if (matcher.skip) {
      skipped.push({
        path: codeowners,
        reason: `Line ${i + 1} has a pattern that the script cannot match: ${matcher.skip}`,
      })
      out.push({ pattern: null, teams: [], unknown: true, matches: () => true })
      return
    }
    const rule = {
      pattern,
      teams: [],
      matches: (root) =>
        root === "." ? WHOLE_REPOSITORY.has(pattern) : matcher.matches(root),
    }
    out.push(rule)
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
    rule.teams = teams
  })
  return out
}

const plans = []
if (codeowners) {
  const parsed = rules(readTracked(source, codeowners))
  const teams = new Map()
  const outOfBudget = () =>
    skipped.push({
      path: codeowners,
      reason:
        "The match budget of the script ran out, so it found no owner for the remaining roots",
    })
  for (const root of roots) {
    if (root.path.split("/").length > MAX_DEPTH) {
      skipped.push({
        path: codeowners,
        reason: `The root is more than ${MAX_DEPTH} levels deep, so the script found no owner for it`,
      })
      continue
    }
    let owner = null
    for (const rule of parsed) {
      if (!matchBudgetLeft()) break
      if (rule.matches(root.path)) owner = rule
    }
    // A run out of budget can miss a later rule, so it gives no owner.
    if (!matchBudgetLeft()) {
      outOfBudget()
      break
    }
    if (!owner) continue
    if (owner.unknown) {
      skipped.push({
        path: codeowners,
        reason: `The owner of root ${root.path} is not known: a rule that the script cannot match can cover it`,
      })
      continue
    }
    for (const team of owner.teams) {
      const key = `${team.org}/${team.name}`
      const entry = teams.get(key) ?? { team, roots: [] }
      entry.roots.push({ root, pattern: owner.pattern })
      teams.set(key, entry)
    }
  }
  const taken = new Map()
  for (const key of [...teams.keys()].sort()) {
    const { team, roots: owned } = teams.get(key)
    // A team name keeps the slash: "@acmep/latform" is not "acme/platform".
    const existing =
      index
        .filter(
          (e) =>
            e.kind === "Team" &&
            typeof e.title === "string" &&
            e.title.toLowerCase() === key.toLowerCase(),
        )
        .map((e) => e.path)
        .sort()[0] ?? null
    const path =
      existing ?? `knowledge/teams/${slug(team.org)}-${slug(team.name)}.md`
    if (taken.has(path)) {
      skipped.push({
        path,
        reason: `The teams ${taken.get(path)} and ${key} have the same file`,
      })
      continue
    }
    taken.set(path, key)
    plans.push({
      path,
      expectName: key,
      exactName: true,
      claims: owned.flatMap((o) =>
        o.root.files.map((file) => ({
          to: relativeTo(path, file.path),
          predicate: "OWNS",
          evidence: { path: codeowners, kind: "script" },
        })),
      ),
      related: owned.map(
        (o) =>
          `- Owns \`${o.root.path}\` in \`${repository}\` (\`${codeowners}\`: \`${o.pattern}\`)`,
      ),
      create: {
        kind: "Team",
        name: key,
        summary: `GitHub team @${key}.`,
        intro: `The GitHub team \`@${key}\`. The CODEOWNERS file of a source repository names it as an owner.`,
      },
    })
  }
}

writeStep(step, plans, skipped)
