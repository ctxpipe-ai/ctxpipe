// Shared code of scan.mjs and apply.mjs. It runs the ast-grep rules of this
// skill over the tracked files of one root and returns the candidate
// dependencies: HTTP calls, queue and stream clients, and config readers.
//
// The source repository is hostile. The rules and the config come from this
// skill folder, never from the checkout: ast-grep runs with `--config` and
// its working folder is the skill folder. It reads only tracked regular
// files below a size cap. A target text reaches the model only when it has
// the shape of a URL, a topic, a queue name, or a variable name (no space),
// so a sentence in a string literal cannot reach the model.

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { dirname, join, posix, sep } from "node:path"
import { fileURLToPath } from "node:url"

import {
  fileClaims,
  listLines,
  listTexts,
  nameKey,
} from "../../bin/knowledge-lib.mjs"
import {
  inTestFixture,
  safePath,
  testFixtureSkips,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")
// No count limit on files, matches, or candidates (CTX-1487): the cursor
// pages over the candidates. A file larger than MAX_FILE_BYTES is not read.
const MAX_FILE_BYTES = 512 * 1024
const BATCH = 100
const MAX_TARGET = 200
const MAX_CAPTURE = 2000

const EXTENSIONS = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".java",
])
/** A folder with one of these names holds no service code of the root. */
const SKIPPED_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  "third_party",
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "mocks",
  "e2e",
  "dist",
  "build",
  "target",
  "generated",
])
const TEST_FILE =
  /(\.(test|spec)\.[a-z]+|_test\.(go|py)|(^|\/)test_[^/]*\.py|(Test|Tests|IT)\.java)$/

const TYPES = new Set(["http", "queue", "stream", "config"])
const DIRECTIONS = new Set(["call", "produce", "consume", "read"])
const TARGET_SHAPE = /^[A-Za-z0-9_.:/@%?&=#+*{}$,;~!()[\]-]{1,200}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/

/** The file is a tracked regular file of the checkout, small, and not behind a symlink. */
function readable(source, realSource, file) {
  try {
    const path = join(source, file)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return false
    return realpathSync(path).startsWith(realSource + sep)
  } catch {
    return false
  }
}

/** Tracked source files of a root, without the other roots below it. */
export function rootFiles({ source, path, otherRoots = [] }) {
  const prefix = path === "." ? "" : `${path}/`
  const nested = otherRoots
    .filter((r) => r !== path && (path === "." || r.startsWith(prefix)))
    .map((r) => `${r}/`)
  return trackedFiles(source)
    .filter((file) => {
      if (!file.startsWith(prefix)) return false
      if (!EXTENSIONS.has(posix.extname(file))) return false
      if (nested.some((n) => file.startsWith(n))) return false
      const below = file.slice(prefix.length)
      if (TEST_FILE.test(below)) return false
      const segments = below.split("/")
      return !segments
        .slice(0, -1)
        .some((s) => s.startsWith(".") || SKIPPED_SEGMENTS.has(s))
    })
    .sort()
}

/** Matches of the rules on a list of files: [{ file, line, ruleId, message, captures }]. */
function runRules(source, files, skipped) {
  const matches = []
  const realSource = realpathSync(source)
  for (let at = 0; at < files.length; at += BATCH) {
    const batch = files.slice(at, at + BATCH)
    const run = spawnSync(
      "ast-grep",
      [
        "scan",
        "--config",
        join(SKILL_DIR, "sgconfig.yml"),
        "--json=stream",
        // Ignore files of the checkout must not hide a file the host listed.
        ...["hidden", "dot", "exclude", "global", "parent", "vcs"].flatMap(
          (kind) => ["--no-ignore", kind],
        ),
        ...batch.map((file) => join(realSource, file)),
      ],
      {
        cwd: SKILL_DIR,
        env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" },
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        timeout: 120_000,
      },
    )
    if (run.error) {
      const reason =
        run.error.code === "ENOENT"
          ? "ast-grep is not installed"
          : `ast-grep failed: ${run.error.code ?? "error"}`
      throw new Error(reason)
    }
    if (run.status !== 0 && run.status !== 1)
      throw new Error(`ast-grep exited with ${run.status}`)
    for (const line of run.stdout.split("\n")) {
      if (!line) continue
      let hit
      try {
        hit = JSON.parse(line)
      } catch {
        continue
      }
      const file = String(hit.file ?? "")
      const relative = file.startsWith(`${realSource}/`)
        ? file.slice(realSource.length + 1)
        : null
      if (!relative || !safePath(relative)) {
        skipped.push({
          path: null,
          reason: "A file path has characters that the script does not quote",
        })
        continue
      }
      const captures = {}
      for (const [name, value] of Object.entries(
        hit.metaVariables?.single ?? {},
      ))
        captures[name] = String(value?.text ?? "").slice(0, MAX_CAPTURE)
      matches.push({
        file: relative,
        line: Number(hit.range?.start?.line ?? 0) + 1,
        ruleId: String(hit.ruleId ?? ""),
        message: String(hit.message ?? ""),
        captures,
      })
    }
  }
  return matches
}

const unquote = (text) => /^(["'`])([\s\S]*)\1$/.exec(text)?.[2] ?? null

/** Env variable name of a read expression, or null. */
function envName(text) {
  const read =
    /^process\.env\.([A-Za-z_]\w*)$/.exec(text)?.[1] ??
    /^process\.env\[\s*["']([^"']+)["']\s*\]$/.exec(text)?.[1] ??
    /^os\.environ\[\s*["']([^"']+)["']\s*\]$/.exec(text)?.[1] ??
    /^(?:os\.getenv|os\.environ\.get|System\.getenv|os\.Getenv)\(\s*["']([^"']+)["']\s*(?:,[\s\S]*)?\)$/.exec(
      text,
    )?.[1] ??
    null
  return read && ENV_NAME.test(read) ? read : null
}

/** A text with no literal part of its own, such as `${base}/x`, names nothing. */
function hasLiteralPart(text) {
  const rest = text.replace(/\$\{[^}]*\}|\{[^}]*\}/g, "")
  return /[A-Za-z]{3}/.test(rest)
}

/**
 * Classify the target text of a match. Returns { kind, text } or null when
 * the text is a variable or an expression, or is not shaped like a name.
 * `kind` is `literal`, `template` (a string with a placeholder), or `env`.
 */
export function classifyTarget(raw, { configName = false } = {}) {
  let text = raw.trim()
  const wrapped = /^aws\.String\(([\s\S]*)\)$/.exec(text)
  if (wrapped) text = wrapped[1].trim()
  if (configName) {
    const name = unquote(text) ?? text
    return ENV_NAME.test(name.replace(/[.-]/g, "_"))
      ? { kind: "env", text: name }
      : null
  }
  const env = envName(text)
  if (env) return { kind: "env", text: env }
  const prefixed = /^[fF]/.test(text) ? text.slice(1) : text
  const inner = unquote(prefixed)
  if (inner === null) return null
  const templated =
    prefixed !== text || (/^`/.test(prefixed) && inner.includes("${"))
  if (templated) {
    if (!inner.includes("{") || !hasLiteralPart(inner)) return null
    const clean = withoutSecrets(inner)
    return TARGET_SHAPE.test(clean) ? { kind: "template", text: clean } : null
  }
  const clean = withoutSecrets(inner)
  return clean.length <= MAX_TARGET && TARGET_SHAPE.test(clean)
    ? { kind: "literal", text: clean }
    : null
}

/**
 * A target without the parts that can hold a credential: the `user:pass@`
 * of a URL, and its query and fragment (`?key=…`). The model never sees
 * them, and the dependency is the host and path.
 */
export function withoutSecrets(target) {
  const scheme = target.indexOf("://")
  let text = target
  if (scheme !== -1) {
    const start = scheme + 3
    const slash = text.indexOf("/", start)
    const authorityEnd = slash === -1 ? text.length : slash
    const at = text.lastIndexOf("@", authorityEnd - 1)
    if (at >= start) text = text.slice(0, start) + text.slice(at + 1)
  }
  const query = text.search(/[?#]/)
  return query === -1 ? text : text.slice(0, query)
}

/** Split a rule message "<type> <direction> <client> <variable>"; null for an unknown message. */
function parseMessage(message) {
  const [type, direction, client, variable, extra] = message.split(" ")
  if (
    extra !== undefined ||
    !TYPES.has(type) ||
    !DIRECTIONS.has(direction) ||
    !/^[a-z0-9-]{1,30}$/.test(client ?? "") ||
    !/^[A-Z]+$/.test(variable ?? "")
  )
    return null
  return { type, direction, client, variable }
}

/** Short names that a target text can stand for, for matching an index title. */
function nameGuesses({ kind, text }, type) {
  const guesses = []
  const trim = (name) =>
    name.replace(
      /([_-](URL|URI|HOST|ADDR|ADDRESS|ENDPOINT|BASE|API|SVC|SERVICE|BROKERS?|TOPICS?|QUEUES?|STREAMS?|SUBJECT|CHANNEL))+$/i,
      "",
    )
  if (kind === "env") guesses.push(trim(text))
  else {
    let host = null
    if (type === "http") {
      try {
        host = new URL(text.includes("://") ? text : `x://${text}`).hostname
      } catch {
        host = null
      }
      if (host && !text.includes("://")) host = null
    }
    if (host) {
      const first = host.split(".")[0] ?? ""
      guesses.push(first, trim(first))
    } else if (type !== "http") {
      const last = text.split(/[/:]/).filter(Boolean).at(-1)
      if (last) guesses.push(last)
    }
  }
  return guesses.filter(Boolean)
}

/** Index entries (Service, API, Stream) that a target may stand for. At most 3. */
function hints(target, type, index, own) {
  const kinds = type === "http" ? ["Service", "API"] : ["Stream", "Service"]
  const want = new Set(nameGuesses(target, type).map(nameKey).filter(Boolean))
  if (!want.size) return []
  return index
    .filter((entry) => kinds.includes(entry.kind) && !own.has(entry.path))
    .filter((entry) => {
      const base = posix.basename(entry.path, ".md")
      return want.has(nameKey(entry.title)) || want.has(nameKey(base))
    })
    .map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      title: String(entry.title ?? "").slice(0, 100),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .slice(0, 3)
}

/**
 * The roots of a step: each root in the repository-wide step (`rootPath`
 * null), else the root of the step. The finder, the list, the writer, and
 * the counts use this one list (CTX-1487).
 */
export function stepRoots(roots, rootPath) {
  if (rootPath === null) return roots
  return [
    roots.find((r) => r.path === rootPath) ?? { path: rootPath, files: [] },
  ]
}

/**
 * The candidates that one step resolves. The root step resolves the HTTP and
 * config candidates. The repository-wide step resolves the other candidates
 * (stream, queue, and config).
 */
export function stepCandidates(candidates, repositoryStep) {
  return candidates.filter((c) =>
    repositoryStep
      ? c.type !== "http"
      : c.type !== "stream" && c.type !== "queue",
  )
}

/**
 * The count of the candidates of a step: the length of the input of the
 * cursor. The finder (`scan.mjs --count`) and the writer count this one
 * list. `scanRoot` gives the scan of one root.
 */
export function stepCandidateCount(roots, rootPath, scanRoot) {
  return stepRoots(roots, rootPath).reduce(
    (sum, root) =>
      sum + stepCandidates(scanRoot(root).candidates, rootPath === null).length,
    0,
  )
}

/**
 * The counts of the candidates of one step, for patch.json: the candidates
 * of each type, and the roots that have candidates but no Service file.
 * `claimable` is true when a root with a candidate has a Service file. Only
 * a Service file gets a claim. `scanRoot` gives the scan of one root.
 */
export function stepStats(roots, rootPath, scanRoot) {
  const stats = {}
  const count = (name) => {
    stats[name] = (stats[name] ?? 0) + 1
  }
  let claimable = false
  for (const root of stepRoots(roots, rootPath)) {
    const mine = stepCandidates(scanRoot(root).candidates, rootPath === null)
    for (const candidate of mine) count(`candidates.${candidate.type}`)
    if (!mine.length) continue
    if (root.files.some((f) => f.kind === "Service")) claimable = true
    else count("roots.no_service")
  }
  return { stats, claimable }
}

/**
 * Scan one root. `index` is the context index entries; `own` is the set of
 * context file paths of this root (a hint never names them).
 * Returns { candidates, skipped }.
 */
export function scan({
  source,
  path,
  otherRoots = [],
  index = [],
  own = new Set(),
}) {
  const listed = rootFiles({ source, path, otherRoots })
  const skipped = testFixtureSkips(listed).map(({ path, reason }) => ({
    path,
    reason,
  }))
  let files = listed.filter((file) => !inTestFixture(file))
  const realSource = realpathSync(source)
  const kept = files.filter((file) => readable(source, realSource, file))
  if (kept.length < files.length)
    skipped.push({
      path: null,
      reason: `${files.length - kept.length} files are larger than ${MAX_FILE_BYTES} bytes, not regular files, or behind a symbolic link, and are not read`,
    })
  files = kept
  const groups = new Map()
  let dropped = 0
  for (const match of runRules(source, files, skipped)) {
    const meta = parseMessage(match.message)
    const raw = meta && match.captures[meta.variable]
    if (!meta || raw === undefined || raw === "") continue
    const target = classifyTarget(raw, {
      configName: meta.type === "config",
    })
    if (!target) {
      dropped++
      continue
    }
    const key = [meta.type, meta.direction, target.kind, target.text].join("|")
    const group = groups.get(key)
    if (group) {
      group.count++
      if (!group.clients.includes(meta.client)) group.clients.push(meta.client)
      if (
        match.file < group.file ||
        (match.file === group.file && match.line < group.line)
      ) {
        group.file = match.file
        group.line = match.line
      }
    } else
      groups.set(key, {
        id: `c${createHash("sha256").update(key).digest("hex").slice(0, 10)}`,
        type: meta.type,
        direction: meta.direction,
        clients: [meta.client],
        target,
        file: match.file,
        line: match.line,
        count: 1,
      })
  }
  if (dropped)
    skipped.push({
      path: null,
      reason: `${dropped} calls have a target that is a variable or has no name shape`,
    })
  const candidates = [...groups.values()].sort((a, b) =>
    a.file !== b.file
      ? a.file < b.file
        ? -1
        : 1
      : a.line - b.line || (a.id < b.id ? -1 : 1),
  )
  return {
    candidates: candidates.map((c) => ({
      ...c,
      clients: [...c.clients].sort(),
      hints: hints(c.target, c.type, index, own),
    })),
    skipped,
  }
}

// --- the cursor (CTX-1487) ---------------------------------------------------

/**
 * The identity of one resolved candidate: a Related line of the
 * dependency list of a Service file. It holds the claim (predicate and
 * target), the source repository, the root, the source file of the call,
 * and the candidate id. The id is the hash that the scan gives the
 * candidate (`c` and 10 hex digits), not a text of the code. Two
 * repositories or two roots can give the same id, so the line names them.
 * The same resolution of a candidate gives the same line. The values are
 * code spans, so each path that `safePath` takes (also one with a space or
 * a parenthesis) reads back the same.
 */
export function dependencyLine({
  predicate,
  link,
  repository,
  root,
  file,
  id,
}) {
  return `- ${predicate} \`${link}\` from \`${repository}\` root \`${root}\` file \`${file}\` (candidate \`${id}\`)`
}

/** The fields of a `dependencyLine`, or null for another line. */
export function parseDependencyLine(text) {
  const line =
    /^- ([A-Z_]+) `([^`\n]+)` from `([^`\n]+)` root `([^`\n]+)` file `([^`\n]+)` \(candidate `(c[0-9a-f]{10})`\)$/.exec(
      text.trim(),
    )
  if (!line) return null
  const [, predicate, link, repository, root, file, id] = line
  return { predicate, link, repository, root, file, id }
}

/** The Related line of a Stream file for one root that produces to or consumes from it. */
export function streamLine({ repository, predicate, root, file }) {
  const verb = predicate === "PRODUCES_TO" ? "produces to" : "consumes from"
  return `- \`${repository}\` ${verb} it in \`${root}\` (\`${file}\`)`
}

/**
 * The ids of the candidates of one root that are resolved in this step, at
 * the step base or in the staged tree. A candidate is resolved when, for
 * each Service file of the root, its dependency list (the Service file and
 * its parts) has an identity line of this repository and root for the
 * candidate with a claim of the step, and has that claim. In the
 * repository-wide step, the Stream file of the claim (or a part of its
 * list) must also have the Related line of the root. An ignored candidate
 * has no identity line, so it is never resolved. A candidate with two lines
 * (resolved to one target and later to another) is one id.
 */
export function resolvedIds(step, root, { repositoryStep, repository }) {
  const services = root.files.filter((f) => f.kind === "Service")
  if (!services.length) return new Set()
  const predicates = repositoryStep
    ? ["PRODUCES_TO", "CONSUMES_FROM"]
    : ["DEPENDS_ON", "CONSUMES_API"]
  // The lines of a Stream file and of the parts of its list (CTX-1528).
  const streams = new Map()
  const streamHas = (path, line) => {
    if (!streams.has(path)) streams.set(path, listLines(step, path))
    return streams.get(path).has(line)
  }
  let done = null
  for (const service of services) {
    const ids = new Set()
    const texts = listTexts(step, service.path).map((part) => part.text)
    const claims = new Set(
      texts.flatMap((text) => [...(fileClaims(text) ?? [])]),
    )
    for (const text of texts) {
      for (const raw of text.split("\n")) {
        const line = parseDependencyLine(raw)
        if (!line) continue
        const { predicate, link, file, id } = line
        if (line.repository !== repository || line.root !== root.path) continue
        if (!predicates.includes(predicate)) continue
        if (!claims.has(`${link} ${predicate}`)) continue
        if (
          repositoryStep &&
          !streamHas(
            posix.normalize(posix.join(posix.dirname(service.path), link)),
            streamLine({ repository, predicate, root: root.path, file }),
          )
        )
          continue
        ids.add(id)
      }
    }
    done = done === null ? ids : new Set([...done].filter((id) => ids.has(id)))
  }
  return done
}
