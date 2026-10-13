#!/usr/bin/env node
// libraries: find the architectural libraries in the dependency manifests of
// each root, and write one knowledge/libraries/<id>.md file for each. A file
// that already describes the library gets new Related lines. No model runs.
//
// node libraries.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> [--roots <discover-roots result>]

import { posix } from "node:path"
import {
  findExisting,
  newFile,
  scriptStep,
  writeStep,
} from "../../bin/knowledge-lib.mjs"
import {
  readTracked,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"
import { CATEGORY_SUMMARY, LIBRARIES } from "./catalog.mjs"

const { step, source, repository, roots, index } = scriptStep()

const pypiName = (name) => name.toLowerCase().replace(/[_.]+/g, "-")

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
    let table = ""
    for (const raw of text.split("\n")) {
      const line = raw.replace(/(^|\s)#.*$/, "").trim()
      const header = /^\[([^[\]]+)\]$/.exec(line)
      if (header) {
        table = header[1].trim()
        const sub =
          /^(?:target\.[^\]]+\.)?dependencies\.([A-Za-z0-9_-]+)$/.exec(table)
        if (sub) add("cargo", sub[1])
        continue
      }
      if (/^(?:target\..+\.)?dependencies$/.test(table)) {
        const key = /^([A-Za-z0-9_-]+)\s*=/.exec(line)
        if (key) add("cargo", key[1])
      }
    }
  } else if (name === "go.mod") {
    const lines = []
    for (const block of text.matchAll(/^require\s*\(([\s\S]*?)^\)/gm))
      lines.push(...block[1].split("\n"))
    for (const single of text.matchAll(/^require\s+([^\s(].*)$/gm))
      lines.push(single[1])
    for (const line of lines) {
      if (/\/\/\s*indirect/.test(line)) continue
      const module = /^\s*([^\s/][^\s]*)\s+v/.exec(line)
      if (module) add("go", module[1])
    }
  } else if (name === "pyproject.toml" || name === "requirements.txt") {
    const specs = []
    if (name === "requirements.txt") specs.push(...text.split("\n"))
    else {
      const project = /\n?\s*dependencies\s*=\s*\[([\s\S]*?)\]/.exec(text)
      if (project)
        specs.push(
          ...[...project[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map(
            (m) => m[1] ?? m[2],
          ),
        )
      const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(
        text,
      )
      if (poetry)
        specs.push(...poetry[1].split("\n").map((l) => l.split("=")[0]))
    }
    for (const spec of specs) {
      const dep = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(
        spec.replace(/#.*$/, ""),
      )
      if (dep && dep[1].toLowerCase() !== "python")
        add("pypi", pypiName(dep[1]))
    }
  } else if (name === "pom.xml") {
    for (const dep of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
      const group = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(dep[1])?.[1]
      const artifact = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(
        dep[1],
      )?.[1]
      if (group && artifact) add("maven", `${group}:${artifact}`)
    }
  } else if (name === "build.gradle" || name === "build.gradle.kts") {
    for (const dep of text.matchAll(
      /\b(?:implementation|api|compileOnly|runtimeOnly)\s*\(?\s*['"]([\w.-]+):([\w.-]+)(?::[^'"]*)?['"]/g,
    ))
      add("maven", `${dep[1]}:${dep[2]}`)
  } else if (name === "Gemfile") {
    for (const dep of text.matchAll(/^\s*gem\s+['"]([\w.-]+)['"]/gm))
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
      const uses = found.get(library.id) ?? { library, lines: new Set() }
      uses.lines.add(
        `- \`${repository}\` uses it in \`${root.path}\` (\`${file}\`: \`${dep.name}\`)`,
      )
      found.set(library.id, uses)
    }
  }
}

const plans = [...found.values()].map(({ library, lines }) => {
  const names = [
    library.name,
    library.id,
    ...["npm", "pypi", "cargo", "go", "maven", "gem"].flatMap(
      (e) => library[e] ?? [],
    ),
  ]
  const path =
    findExisting(index, "Library", names) ??
    `knowledge/libraries/${library.id}.md`
  const related = [...lines].sort()
  return {
    path,
    claims: [],
    related,
    create: () => {
      const summary = CATEGORY_SUMMARY[library.category]
      return newFile({
        kind: "Library",
        name: library.name,
        summary,
        intro: `${summary} A script found it in the dependency manifests of a source repository.`,
        claims: [],
        related,
      })
    },
  }
})

writeStep(step, plans)
