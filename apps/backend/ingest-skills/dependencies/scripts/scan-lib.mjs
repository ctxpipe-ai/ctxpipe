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
import { nameKey } from "../../bin/knowledge-lib.mjs"
import {
  safePath,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")
const MAX_FILES = 5000
const MAX_FILE_BYTES = 512 * 1024
const BATCH = 100
const MAX_MATCHES = 20_000
const MAX_CANDIDATES = 300
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
  "testdata",
  "fixtures",
  "__fixtures__",
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
  for (
    let at = 0;
    at < files.length && matches.length < MAX_MATCHES;
    at += BATCH
  ) {
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
      if (!line || matches.length >= MAX_MATCHES) continue
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
 * Scan one root. `index` is the context index entries; `own` is the set of
 * context file paths of this root (a hint never names them).
 * Returns { candidates, skipped, truncated }.
 */
export function scan({
  source,
  path,
  otherRoots = [],
  index = [],
  own = new Set(),
}) {
  const skipped = []
  let files = rootFiles({ source, path, otherRoots })
  let truncated = false
  if (files.length > MAX_FILES) {
    files = files.slice(0, MAX_FILES)
    truncated = true
    skipped.push({
      path: null,
      reason: `The script read only the first ${MAX_FILES} source files`,
    })
  }
  const realSource = realpathSync(source)
  files = files.filter((file) => readable(source, realSource, file))
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
  let candidates = [...groups.values()].sort((a, b) =>
    a.file !== b.file
      ? a.file < b.file
        ? -1
        : 1
      : a.line - b.line || (a.id < b.id ? -1 : 1),
  )
  if (candidates.length > MAX_CANDIDATES) {
    candidates = candidates.slice(0, MAX_CANDIDATES)
    truncated = true
  }
  return {
    candidates: candidates.map((c) => ({
      ...c,
      clients: [...c.clients].sort(),
      hints: hints(c.target, c.type, index, own),
    })),
    skipped,
    truncated,
  }
}
