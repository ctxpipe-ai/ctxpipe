// The finders of the feature-gates skill (CTX-1513). A feature gate is a
// named switch that turns a feature on or off, with a stage (alpha, beta,
// GA, deprecated; or unstable, accepted, removed) and a default. Two
// conventions are known:
//
// - Go, the Kubernetes `featuregate` package: a constant
//   `Name featuregate.Feature = "Name"` with `// owner:` and `// kep:` lines
//   in its comment, and a spec map `Name: {{Version: ..., Default: ...,
//   PreRelease: featuregate.Beta}}` in the same package.
// - Rust, the `declare_features!` macro of the Rust compiler:
//   `(unstable, name, "1.63.0", Some(12345))` with `///` doc lines.
//
// Only a file whose path names a feature (a `feature` folder or file name)
// is read, so the scan reads a few files of a large repository, not each one.

import { posix } from "node:path"

import {
  ignoredFolder,
  readTracked,
} from "../../discover-roots/scripts/roots-lib.mjs"

const GO_GATE =
  /^[ \t]*([A-Z][A-Za-z0-9_]{0,99})[ \t]+(?:[a-z][a-z0-9]*\.)?Feature[ \t]*=[ \t]*"([A-Za-z][A-Za-z0-9_.-]{0,99})"/
const RUST_GATE =
  /^[ \t]*\((unstable|incomplete|internal|accepted|removed|stable_removed),[ \t]*([a-z_][a-z0-9_]{0,99}),[ \t]*"([^"\n]{0,40})",[ \t]*(None|Some\((\d{1,7})\))/
const VERSION = /^v?[0-9][0-9A-Za-z.+-]{0,30}$|^CURRENT_RUSTC_VERSION$/
const HANDLE = /@[A-Za-z0-9][A-Za-z0-9-]{0,38}/g
/** The description of a gate keeps its first 2 KiB; a longer one ends with "…". */
const MAX_DESCRIPTION_BYTES = 2048

/** Folder names of tests and examples: their gates are fixtures, not gates of the product. */
const TEST_SEGMENT = /^(?:tests?|testing|e2e|examples?|samples?)$/i

/** True for a source file that can declare feature gates. */
export function gateFile(path) {
  if (!/\.(go|rs)$/.test(path) || /_test\.go$/.test(path)) return false
  const dir = posix.dirname(path)
  if (ignoredFolder(dir === "" ? "." : dir)) return false
  if (dir.split("/").some((segment) => TEST_SEGMENT.test(segment))) return false
  return /feature/i.test(path)
}

/** The doc comment lines directly above line `at`, top first, without the comment marks. */
function commentAbove(lines, at, mark) {
  const out = []
  for (let i = at - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith(mark)) break
    out.unshift(line.slice(mark.length).replace(/^ /, ""))
  }
  return out
}

/**
 * A description, cut at a UTF-8 byte limit, and the count of source bytes
 * that the cut removed (`descriptionCut`).
 */
function cut(text) {
  const bytes = Buffer.byteLength(text)
  if (bytes <= MAX_DESCRIPTION_BYTES)
    return { description: text, descriptionCut: 0 }
  let out = text
  while (Buffer.byteLength(`${out}…`) > MAX_DESCRIPTION_BYTES)
    out = out.slice(0, -1)
  out = out.trimEnd()
  return {
    description: `${out}…`,
    descriptionCut: bytes - Buffer.byteLength(out),
  }
}

/** The tags (`owner:`, `kep:`, `alpha:`) and the description of a Go gate comment. */
function goComment(lines) {
  const tags = { owners: [], keps: [], stages: [] }
  const text = []
  for (const line of lines) {
    const tag = /^([a-z]+):\s*(.*)$/i.exec(line)
    const key = tag?.[1].toLowerCase()
    if (key === "owner" || key === "owners")
      tags.owners.push(...(tag[2].match(HANDLE) ?? []))
    else if (key === "kep")
      for (const m of tag[2].matchAll(
        /(?:kep\.k8s\.io\/|kubernetes\/enhancements\/(?:issues|pull)\/|keps\/[a-z0-9-]+\/)(\d{1,6})/g,
      ))
        tags.keps.push(Number(m[1]))
    else if (key && ["alpha", "beta", "ga", "deprecated"].includes(key))
      tags.stages.push({ stage: key, version: tag[2].trim() })
    else text.push(line)
  }
  return {
    ...tags,
    ...cut(text.join(" ").replace(/\s+/g, " ").trim()),
  }
}

/** The text between the brace at `open` and its closing brace, or null. */
function braced(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i)
  }
  return null
}

/**
 * The specs of a Go gate in `text`, oldest first: the versioned form
 * `Name: { {Version: …, Default: …, PreRelease: …}, … }`, or the older form
 * `Name: {Default: …, PreRelease: …}`.
 */
function goSpecs(text, ident) {
  // Another map (for example the gate dependencies) can use the same key.
  for (const key of text.matchAll(
    new RegExp(`(?:^|[\\s,{])${ident}:\\s*\\{`, "gm"),
  )) {
    const body = braced(text, key.index + key[0].length - 1) ?? ""
    // A versioned entry has a list of specs; an older one is one spec.
    const specs = goSpecList(body)
    if (specs.length) return specs
    const single = goSpecList(`{${body}}`)
    if (single.length) return single
  }
  return []
}

function goSpecList(body) {
  const specs = []
  for (const m of body.matchAll(/\{([^{}]*PreRelease[^{}]*)\}/g)) {
    const spec = m[1]
    const stage = /PreRelease:\s*(?:\w+\.)?(\w+)/.exec(spec)?.[1]
    const def = /Default:\s*(true|false)/.exec(spec)?.[1]
    if (!stage || !def) continue
    const version = /Version:\s*version\.\w+\("([^"]+)"\)/.exec(spec)?.[1]
    specs.push({
      stage,
      default: def === "true",
      locked: /LockToDefault:\s*true/.test(spec),
      version: version && VERSION.test(version) ? version : null,
    })
  }
  return specs
}

/**
 * The feature gates of the given files. Each gate is
 * { name, file, line, convention, stage, default, locked, since, history,
 *   owners, keps, issue, description, descriptionCut }.
 */
export function findGates(source, paths) {
  const texts = new Map(paths.map((p) => [p, readTracked(source, p)]))
  const gates = []
  for (const [file, text] of texts) {
    const lines = text.split("\n")
    if (file.endsWith(".go")) {
      // The spec map can be in any file of the same Go package.
      const siblings = [...texts]
        .filter(([p]) => posix.dirname(p) === posix.dirname(file))
        .map(([, t]) => t)
      lines.forEach((line, i) => {
        const m = GO_GATE.exec(line)
        if (!m) return
        const comment = goComment(commentAbove(lines, i, "//"))
        const specs = siblings.flatMap((t) => goSpecs(t, m[1]))
        const last = specs.at(-1)
        const first = specs.find((s) => s.stage === last?.stage)
        gates.push({
          name: m[2],
          file,
          line: i + 1,
          convention: "go",
          stage: last?.stage ?? comment.stages.at(-1)?.stage ?? null,
          default: last ? last.default : null,
          locked: last?.locked ?? false,
          since: first?.version ?? comment.stages.at(-1)?.version ?? null,
          history: specs,
          owners: [...new Set(comment.owners)],
          keps: [...new Set(comment.keps)],
          issue: null,
          description: comment.description,
          descriptionCut: comment.descriptionCut,
        })
      })
    } else if (/declare_features!\s*\(/.test(text)) {
      lines.forEach((line, i) => {
        const m = RUST_GATE.exec(line)
        if (!m) return
        const doc = commentAbove(lines, i, "///")
        gates.push({
          name: m[2],
          file,
          line: i + 1,
          convention: "rust",
          stage: m[1],
          default: null,
          locked: false,
          since: VERSION.test(m[3]) ? m[3] : null,
          history: [],
          owners: [],
          keps: [],
          issue: m[5] ? Number(m[5]) : null,
          ...cut(doc.join(" ").replace(/\s+/g, " ").trim()),
        })
      })
    }
  }
  return gates
}
