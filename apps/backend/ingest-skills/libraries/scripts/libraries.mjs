#!/usr/bin/env node
// libraries: a repository-wide step on the assembled ref, after the root
// steps. It finds the architectural libraries in the dependency manifests of
// each root, and writes one knowledge/libraries/<id>.md file for each. A file
// that already describes the library gets new Related lines. Each mapped
// root file of kind Service or Repository gets a USES_LIBRARY claim to the
// library file. No model runs. A step writes at most 30 files; the host runs
// it again while the result has `more: true`.
//
// node libraries.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --roots <root-to-file map>

import { posix } from "node:path"
import {
  findExisting,
  relativeTo,
  scriptStep,
  writeStep,
} from "../../bin/knowledge-lib.mjs"
import {
  readTracked,
  tomlStringArray,
  tomlTables,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"
import { CATEGORY_SUMMARY, LIBRARIES } from "./catalog.mjs"

const { step, source, repository, roots, index, skipped } = scriptStep()

const pypiName = (name) => name.toLowerCase().replace(/[_.]+/g, "-")
const CRATE = /^[A-Za-z0-9_-]+$/

/** Crate names of a Cargo.toml: `[dependencies]` keys and `[dependencies.<name>]` tables, also under `target.<cfg>`. */
function cargoDependencies(text) {
  const out = []
  for (const [table, lines] of tomlTables(text)) {
    const plain =
      table === "dependencies" ||
      (table.startsWith("target.") && table.endsWith(".dependencies"))
    if (plain) {
      for (const line of lines) {
        const key = line.trim().split("=")[0]?.trim()
        if (line.includes("=") && CRATE.test(key)) out.push(key)
      }
      continue
    }
    const at = table.startsWith("dependencies.")
      ? "dependencies.".length
      : table.startsWith("target.") && table.includes(".dependencies.")
        ? table.lastIndexOf(".dependencies.") + ".dependencies.".length
        : -1
    if (at !== -1 && CRATE.test(table.slice(at))) out.push(table.slice(at))
  }
  return out
}

/** Direct (not `// indirect`) modules of a go.mod, line by line. */
function goDependencies(text) {
  const out = []
  let inBlock = false
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (inBlock && line.startsWith(")")) {
      inBlock = false
      continue
    }
    let spec = null
    if (inBlock) spec = line
    else if (/^require\s*\($/.test(line)) inBlock = true
    else if (line.startsWith("require ")) spec = line.slice(8).trim()
    if (!spec || /\/\/\s*indirect/.test(spec)) continue
    const [module, version] = spec.split(/\s+/)
    if (module && version?.startsWith("v")) out.push(module)
  }
  return out
}

/** Direct dependencies of one manifest: [{ ecosystem, name }]. */
function dependencies(file, text) {
  const name = posix.basename(file)
  const out = []
  const add = (ecosystem, dep) => dep && out.push({ ecosystem, name: dep })
  if (name === "package.json") {
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      return out
    }
    for (const key of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
    ])
      for (const dep of Object.keys(json?.[key] ?? {})) add("npm", dep)
  } else if (name === "Cargo.toml") {
    for (const dep of cargoDependencies(text)) add("cargo", dep)
  } else if (name === "go.mod") {
    for (const dep of goDependencies(text)) add("go", dep)
  } else if (name === "pyproject.toml" || name === "requirements.txt") {
    const specs = []
    if (name === "requirements.txt") specs.push(...text.split("\n"))
    else {
      const tables = tomlTables(text)
      specs.push(...tomlStringArray(tables, "project", "dependencies"))
      for (const line of tables.get("tool.poetry.dependencies") ?? [])
        specs.push(line.split("=")[0])
    }
    for (const spec of specs) {
      const dep = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(
        spec.replace(/#.*$/, ""),
      )
      if (dep && dep[1].toLowerCase() !== "python")
        add("pypi", pypiName(dep[1]))
    }
  } else if (name === "pom.xml") {
    for (const part of text.split("<dependency>").slice(1)) {
      const dep = part.split("</dependency>")[0]
      const group = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(dep)?.[1]
      const artifact = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(
        dep,
      )?.[1]
      if (group && artifact) add("maven", `${group}:${artifact}`)
    }
  } else if (name === "build.gradle" || name === "build.gradle.kts") {
    for (const dep of text.matchAll(
      /\b(?:implementation|api|compileOnly|runtimeOnly)[ \t]*\(?[ \t]*['"]([\w.-]+):([\w.-]+)(?::[^'"\n]*)?['"]/g,
    ))
      add("maven", `${dep[1]}:${dep[2]}`)
  } else if (name === "Gemfile") {
    for (const dep of text.matchAll(/^[ \t]*gem[ \t]+['"]([\w.-]+)['"]/gm))
      add("gem", dep[1])
  }
  return out
}

const MANIFESTS = new Set([
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
])

function catalogEntry(ecosystem, dep) {
  for (const library of LIBRARIES) {
    for (const known of library[ecosystem] ?? []) {
      if (dep === known) return library
      // Go major versions: github.com/redis/go-redis/v9
      if (
        ecosystem === "go" &&
        new RegExp(`^${known.replace(/[.]/g, "\\.")}/v\\d+$`).test(dep)
      )
        return library
    }
  }
  return null
}

const SAFE_PACKAGE = /^[@A-Za-z0-9][@A-Za-z0-9_./:-]{0,199}$/
/** Kinds of a root file that can use a library. These are validator kind names (`knowledge/codebases/` holds `Repository`). */
const USES_LIBRARY_KINDS = new Set(["Service", "Repository"])
const files = new Set(trackedFiles(source))
const found = new Map()
for (const root of roots) {
  const dir = root.path === "." ? "" : `${root.path}/`
  for (const manifest of [...MANIFESTS].sort()) {
    const file = `${dir}${manifest}`
    if (!files.has(file)) continue
    for (const dep of dependencies(file, readTracked(source, file))) {
      const library = catalogEntry(dep.ecosystem, dep.name)
      if (!library || !SAFE_PACKAGE.test(dep.name)) continue
      const uses = found.get(library.id) ?? {
        library,
        lines: [],
        users: [],
      }
      uses.lines.push(
        `- \`${repository}\` uses it in \`${root.path}\` (\`${file}\`: \`${dep.name}\`)`,
      )
      for (const target of root.files)
        if (USES_LIBRARY_KINDS.has(target.kind))
          uses.users.push({ path: target.path, evidence: file })
      found.set(library.id, uses)
    }
  }
}

const plans = []
for (const { library, lines, users } of found.values()) {
  const names = [
    library.name,
    library.id,
    ...["npm", "pypi", "cargo", "go", "maven", "gem"].flatMap(
      (e) => library[e] ?? [],
    ),
  ]
  const existing = findExisting(index, "Library", names)
  const path = existing ?? `knowledge/libraries/${library.id}.md`
  const summary = CATEGORY_SUMMARY[library.category]
  plans.push({
    path,
    claims: [],
    related: lines,
    expectName: existing ? undefined : library.name,
    create: {
      kind: "Library",
      name: library.name,
      summary,
      intro: `${summary} A script found it in the dependency manifests of a source repository.`,
    },
  })
  for (const user of users)
    plans.push({
      path: user.path,
      create: null,
      related: [],
      claims: [
        {
          to: relativeTo(user.path, path),
          predicate: "USES_LIBRARY",
          evidence: { path: user.evidence, kind: "script" },
        },
      ],
    })
}

writeStep(step, plans, skipped)
