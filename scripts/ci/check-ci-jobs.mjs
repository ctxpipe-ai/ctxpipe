// Rejects CI work that costs money on each pull request push without a
// decision, and a check whose cache key is missing or bound to one host.
// The result depends only on the workflows and the scripts, so it is a
// cacheable check.
//
// 1. A job that starts on a `pull_request` event runs only when the merge
//    gate plan selects it, or it has a reason. A job is in the gate when it
//    needs `merge-gate-plan` and one term of its `if:` is a selection: each
//    part of the term is `outputs.<job> != ''`, `outputs.<x> == 'true'`,
//    `outputs.mode != 'gate'` or `outputs.mode == ''` of that job. A job
//    that runs only after another job ran (each of its `needs` when its `if:`
//    has no `always()`, `cancelled()` or `failure()`, or a term
//    `needs.<job>.outputs.<x> != ''`, `== '<value>'` or
//    `needs.<job>.result == 'success'`) has the state of that job. A job
//    whose `if:` excludes a pull request (another event, a branch ref) does
//    not start on one. Each other job needs a comment line
//    `# outside-gate: <reason>` in its job block or directly above it.
// 2. A job in the gate runs its checks through the manifest runner
//    (scripts/checks/run.mjs, selected.mjs or `checks:run`). When it starts
//    a check tool itself (Vitest, `node --test`, a policy script, a linter,
//    a type checker, Terraform, an image build), or runs a script without
//    the manifest runner, it needs a comment line
//    `# outside-manifest: <reason>`.
// 3. The import closure of the check runner (scripts/checks/run.mjs), of
//    each policy script (scripts/ci/check-*.mjs) and of each test of the CI
//    scripts (scripts/tests/*.test.mjs), inside scripts/, has only literal
//    specifiers: the selector gives no cache key to a check whose closure
//    has a computed import().
// 4. A check that is not portable has a stated reason: each entry of
//    scripts/checks/non-portable.json is `"<check id>": "<reason>"`. (A
//    project check without a cache states its reason as `uncached` in
//    scripts/checks/projects.mjs.)
//
// Usage: node scripts/ci/check-ci-jobs.mjs [--root <dir>]

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, posix } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const { values: args } = parseArgs({ options: { root: { type: "string" } } })
const root = args.root ?? fileURLToPath(new URL("../..", import.meta.url))
const failures = []

// --- Workflows -------------------------------------------------------------

const indentOf = (line) => line.length - line.trimStart().length
const isComment = (line) => line.trim().startsWith("#")
const hasReason = (job, kind) =>
  job.comments.some((line) => new RegExp(`^#\\s*${kind}:\\s*\\S`).test(line))

// The value of a key at `indent` in `lines`, with its continuation lines.
function field(lines, indent, key) {
  const at = lines.findIndex(
    (line) => indentOf(line) === indent && line.trim().startsWith(`${key}:`),
  )
  if (at < 0) return undefined
  const first = lines[at]
    .trim()
    .slice(key.length + 1)
    .replace(/\s+#.*$/, "")
  const rest = []
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "" || isComment(line)) continue
    if (indentOf(line) <= indent) break
    rest.push(line.trim())
  }
  return [first.replace(/^[|>][-+]?$/, ""), ...rest].join(" ").trim()
}

// A step that starts a check tool itself, not through the manifest runner.
// A step that starts a check tool itself, not through the manifest runner:
// pnpm and npx with any options, a policy script, or an image build.
const checkTool =
  /(?:^|[\s;&|(])(?:(?:pnpm|npx)(?:\s+-{1,2}[\w-]+(?:[ =][^\s;&|]+)?)*\s+(?:exec\s+|run\s+)?(?:vitest|playwright\s+test|oxlint|oxfmt|knip|tsc|test|lint|typecheck|format:check)\b|(?:vitest|playwright test|oxlint|oxfmt|knip|tsc|bun check)\b|node\s+(?:--test\b|\S*scripts\/ci\/check-[\w-]+\.mjs)|terraform\s+(?:validate|plan)\b|docker\s+(?:buildx\s+)?build\b)|uses:\s*docker\/build-push-action@/
// A step that runs the planned checks through the manifest runner.
const manifestRunner = /scripts\/checks\/(?:run|selected)\.mjs|checks:run\b/

// The jobs of a workflow. The parser reads the subset of YAML that the
// workflows use; a job key that it cannot read is a failure.
function parseWorkflow(file, text) {
  const lines = text.split("\n")
  const onAt = lines.findIndex((line) => /^"?on"?:/.test(line))
  const inline = lines[onAt]?.replace(/^"?on"?:/, "").replace(/\s+#.*$/, "")
  const triggers = inline?.trim() ? (inline.match(/[\w-]+/g) ?? []) : []
  if (onAt >= 0 && !inline.trim())
    for (const line of lines.slice(onAt + 1)) {
      if (/^\S/.test(line) && !isComment(line)) break
      const trigger = line.match(/^ {2}([\w-]+):/)?.[1]
      if (trigger) triggers.push(trigger)
    }
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line))
  const keys = []
  for (let index = jobsAt + 1; jobsAt >= 0 && index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() === "" || isComment(line)) continue
    if (indentOf(line) === 0) break
    if (indentOf(line) !== 2) continue
    const key = line.match(/^ {2}(["']?)([\w-]+)\1:\s*(#.*)?$/)
    if (key) keys.push({ index, id: key[2] })
    else
      failures.push(
        `${file}:${index + 1}: a job key that the guard cannot read. Write each job as "  <id>:" with its fields below it.`,
      )
  }
  const end = lines.findIndex(
    (line, index) => index > jobsAt && /^\S/.test(line) && !isComment(line),
  )
  // A job owns the comment lines directly above its key.
  const starts = keys.map(({ index }) => {
    let start = index
    while (start > jobsAt + 1 && isComment(lines[start - 1])) start--
    return start
  })
  const jobs = keys.map(({ index: key, id }, at) => {
    const own = lines.slice(
      starts[at],
      starts[at + 1] ?? (end < 0 ? lines.length : end),
    )
    const body = own.slice(key - starts[at] + 1)
    const needs = (field(body, 4, "needs") ?? "")
      .replace(/[[\],]/g, " ")
      .split(/\s+/)
      .filter((token) => token && token !== "-")
    return {
      id,
      line: key + 1,
      comments: own.filter(isComment).map((line) => line.trim()),
      tool: body.some((line) => !isComment(line) && checkTool.test(line)),
      // A job with a script and no manifest runner does its own work.
      ownWork:
        body.some((line) => /^\s*(?:-\s+)?run:/.test(line)) &&
        !body.some((line) => !isComment(line) && manifestRunner.test(line)),
      needs,
      if: (field(body, 4, "if") ?? "")
        .replace(/^\$\{\{\s*/, "")
        .replace(/\s*\}\}$/, ""),
    }
  })
  return {
    pullRequest: triggers.some((t) => /^pull_request(_target)?$/.test(t)),
    jobs,
  }
}

// Splits at `separator` (&& or ||) outside parentheses and quotes.
function split(expression, separator) {
  const parts = []
  let depth = 0
  let quote = false
  let start = 0
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index]
    if (char === "'") quote = !quote
    if (quote) continue
    if (char === "(") depth++
    if (char === ")") depth--
    if (depth === 0 && expression.startsWith(separator, index)) {
      parts.push(expression.slice(start, index))
      start = index + separator.length
    }
  }
  return [...parts, expression.slice(start)].map((part) => part.trim())
}

// Removes the parentheses around a whole term.
function unwrap(term) {
  for (;;) {
    let depth = 0
    let quote = false
    let close = -1
    for (let index = 0; index < term.length && close < 0; index++) {
      if (term[index] === "'") quote = !quote
      if (quote) continue
      if (term[index] === "(") depth++
      if (term[index] === ")" && --depth === 0) close = index
    }
    if (!term.startsWith("(") || close !== term.length - 1) return term
    term = term.slice(1, -1).trim()
  }
}

// True when a term is false on each pull request run.
function excludes(term) {
  const or = split(unwrap(term), "||")
  if (or.length > 1) return or.every(excludes)
  const event = or[0].match(/^github\.event_name\s*(==|!=)\s*'([^']*)'$/)
  if (event)
    return (event[1] === "==") !== /^pull_request(_target)?$/.test(event[2])
  return /^github\.ref\s*==\s*'refs\/heads\//.test(or[0])
}

// True when a term runs the job only when the plan selects it, or only in a
// run that is not gated.
function selects(term) {
  const parts = split(unwrap(term), "||").map(unwrap)
  const plan = /^needs\.merge-gate-plan\.outputs\./
  const ungated = (part) =>
    new RegExp(`${plan.source}mode\\s*(?:!=\\s*'gate'|==\\s*'')$`).test(part)
  const selection = (part) =>
    new RegExp(
      `${plan.source}(?!mode\\b)[\\w-]+\\s*(?:!=\\s*''|==\\s*'true')$`,
    ).test(part)
  return (
    parts.every((part) => ungated(part) || selection(part)) &&
    (parts.some(selection) || parts.length === 1)
  )
}

// The job that a term needs to have run, as `needs.<job>.…`.
const needed = (term) =>
  unwrap(term).match(
    /^needs\.([\w-]+)\.(?:outputs\.[\w-]+\s*(?:!=\s*''|==\s*'[^']+')|result\s*==\s*'success')$/,
  )?.[1]

// The state of each job on a pull request run: `excluded`, `gated`, `exempt`
// (with the job that has the reason as `root`) or `open`.
function jobStates(workflow) {
  const byId = new Map(workflow.jobs.map((job) => [job.id, job]))
  const states = new Map()
  const state = (job) => {
    if (states.has(job.id)) return states.get(job.id)
    const terms = job.if ? split(job.if, "&&") : []
    const after = terms.map(needed).filter(Boolean)
    if (!/\b(always|cancelled|failure)\(\)/.test(job.if))
      after.push(...job.needs)
    // A job after the plan is in the gate only by a selection term.
    const earlier = after
      .filter((id) => byId.has(id) && id !== "merge-gate-plan")
      .map((id) => state(byId.get(id)))
    let result
    if (terms.some(excludes) || earlier.some((s) => s.kind === "excluded"))
      result = { kind: "excluded" }
    else if (
      (job.needs.includes("merge-gate-plan") && terms.some(selects)) ||
      earlier.some((s) => s.kind === "gated")
    )
      result = { kind: "gated" }
    else if (hasReason(job, "outside-gate"))
      result = { kind: "exempt", root: job.id }
    else
      result = earlier.find((s) => s.kind === "exempt") ??
        earlier.find((s) => s.kind === "open") ?? { kind: "open", root: job.id }
    states.set(job.id, result)
    return result
  }
  for (const job of workflow.jobs) state(job)
  return states
}

for (const name of readdirSync(join(root, ".github/workflows")).sort()) {
  if (!/\.ya?ml$/.test(name)) continue
  const file = `.github/workflows/${name}`
  const workflow = parseWorkflow(file, readFileSync(join(root, file), "utf8"))
  if (!workflow.pullRequest) continue
  const states = jobStates(workflow)
  for (const job of workflow.jobs) {
    const { kind, root: start } = states.get(job.id)
    if (kind === "open" && start === job.id)
      failures.push(
        `${file}:${job.line}: job "${job.id}" starts on each pull request push outside the merge gate. Select it with the merge gate plan (needs: merge-gate-plan, and an if: on the output of its selection), or add "# outside-gate: <reason>" above the job (scripts/checks/README.md, Jobs outside the merge gate).`,
      )
    if (
      kind === "gated" &&
      (job.tool || job.ownWork) &&
      !hasReason(job, "outside-manifest")
    )
      failures.push(
        `${file}:${job.line}: job "${job.id}" ${job.tool ? "starts a check tool itself" : "runs a script but no manifest runner"}, so factory check cannot run that work. Run it as a check of the manifest (scripts/checks/run.mjs or selected.mjs), or add "# outside-manifest: <reason>" above the job.`,
      )
  }
}

// --- Cache keys of the CI script checks -----------------------------------

// The first computed import() in the closure of `file`, as `<file>:<line>`.
// A literal specifier is one string, then `)` or `,`; `import()` is prose.
function computedImport(file, seen = new Set()) {
  // The check reads only scripts/, as its inputs say; the tests of the
  // CI scripts that import app files have those files as inputs.
  if (seen.has(file) || !file.startsWith("scripts/")) return undefined
  if (!existsSync(join(root, file))) return undefined
  seen.add(file)
  const text = readFileSync(join(root, file), "utf8")
  for (const match of text.matchAll(/\bimport\s*\(/g)) {
    const rest = text.slice(match.index + match[0].length)
    if (/^\s*(?:\)|(["'])[^"'\n]*\1\s*[,)]|`[^`$]*`\s*[,)])/.test(rest))
      continue
    return `${file}:${text.slice(0, match.index).split("\n").length}`
  }
  for (const [, specifier] of text.matchAll(
    /(?:\bfrom\s+|\bimport\s*\(?\s*)["'`](\.{1,2}\/[^"'`]+\.(?:mjs|js|ts))["'`]/g,
  )) {
    const found = computedImport(
      posix.join(posix.dirname(file), specifier),
      seen,
    )
    if (found) return found
  }
  return undefined
}

const scripts = (directory, pattern) =>
  existsSync(join(root, directory))
    ? readdirSync(join(root, directory))
        .filter((name) => pattern.test(name))
        .sort()
        .map((name) => `${directory}/${name}`)
    : []
for (const file of [
  "scripts/checks/run.mjs",
  ...scripts("scripts/ci", /^check-.*\.mjs$/),
  ...scripts("scripts/tests", /\.test\.mjs$/),
]) {
  const found = computedImport(file)
  if (found)
    failures.push(
      `${file}: ${found} has an import() with a computed specifier, so the selector gives its check no cache key, and the merge gate runs it on each pull request that changes its inputs. Import by a literal specifier, or move that code out of the import closure.`,
    )
}

// --- Portable keys ---------------------------------------------------------

const nonPortable = JSON.parse(
  readFileSync(join(root, "scripts/checks/non-portable.json"), "utf8"),
)
if (Array.isArray(nonPortable))
  failures.push(
    'scripts/checks/non-portable.json: give each check its reason, as "<check id>": "<reason>".',
  )
else
  for (const [id, reason] of Object.entries(nonPortable))
    if (typeof reason !== "string" || !reason.trim())
      failures.push(
        `scripts/checks/non-portable.json: "${id}" has no reason. State why its result depends on the host.`,
      )

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exit(1)
}
