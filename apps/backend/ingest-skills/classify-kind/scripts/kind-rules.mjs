// Rules of the classify-kind skill: manifest and entrypoint rules that give
// the kind of one code root (App, Service, or Library). Each rule gives a
// signal with its evidence file. A strong signal wins over a weak one. When
// the strong signals (or, with no strong signal, the weak signals) give more
// than one kind, or no rule matches, the root is ambiguous and the model
// chooses from the options.
//
// The rules read only tracked files at HEAD through `readTracked`, so a
// symlink gives its target path as text, not the file it points to.

import { posix } from "node:path"
import {
  readTracked,
  tomlStringArray,
  tomlTables,
} from "../../discover-roots/scripts/roots-lib.mjs"

const MAX_MANIFEST_CHARS = 256 * 1024

export const KINDS = ["App", "Library", "Service"]

/** Dependencies that make a JavaScript package a client application. */
const APP_DEPENDENCIES = new Set([
  "electron",
  "react-native",
  "expo",
  "@capacitor/core",
  "@tauri-apps/api",
  "next",
  "nuxt",
  "@sveltejs/kit",
  "@remix-run/react",
  "gatsby",
  "astro",
  "@angular/core",
])

/** Dependencies that make a JavaScript package a server. */
const SERVER_DEPENDENCIES = new Set([
  "express",
  "fastify",
  "hono",
  "koa",
  "@nestjs/core",
  "@hapi/hapi",
  "@apollo/server",
  "apollo-server",
  "graphql-yoga",
  "@grpc/grpc-js",
  "bullmq",
])

const PYTHON_SERVER = new Set([
  "fastapi",
  "flask",
  "django",
  "starlette",
  "aiohttp",
  "celery",
  "sanic",
  "tornado",
  "grpcio",
])

/** Files that deploy a root as a running service. */
const DEPLOY_FILES = [
  "Procfile",
  "fly.toml",
  "wrangler.toml",
  "serverless.yml",
  "serverless.yaml",
]

const parseJson = (text) => {
  try {
    const value = JSON.parse(text)
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null
  } catch {
    return null
  }
}

const SAFE_NAME = /^[@A-Za-z0-9][@A-Za-z0-9_./-]{0,99}$/

/** A manifest name that is safe to use as a file name and a title, or null. */
function safeName(text) {
  if (typeof text !== "string") return null
  const name = text.trim()
  return SAFE_NAME.test(name) && !name.includes("..") ? name : null
}

/**
 * Classify one root. `files` is the set of tracked files of the source.
 * Returns { name, signals: [{ kind, strength, evidence, reason }] }.
 */
export function classifyRoot(source, files, rootPath) {
  const dir = rootPath === "." ? "" : `${rootPath}/`
  const has = (path) => files.has(`${dir}${path}`)
  // A manifest is small; a longer text is cut, so each rule reads a bounded text.
  const read = (path) =>
    readTracked(source, `${dir}${path}`).slice(0, MAX_MANIFEST_CHARS)
  const signals = []
  let name = null
  const signal = (kind, strength, path, reason) =>
    signals.push({ kind, strength, evidence: `${dir}${path}`, reason })

  if (has("package.json")) {
    const json = parseJson(read("package.json"))
    if (json) {
      name ??= safeName(json.name)
      const deps = new Set([
        ...Object.keys(json.dependencies ?? {}),
        ...Object.keys(json.devDependencies ?? {}),
      ])
      for (const dep of [...deps].sort()) {
        if (APP_DEPENDENCIES.has(dep))
          signal("App", "strong", "package.json", `It depends on ${dep}`)
        if (SERVER_DEPENDENCIES.has(dep) && json.dependencies?.[dep])
          signal("Service", "strong", "package.json", `It depends on ${dep}`)
      }
      if (
        has("index.html") &&
        ["vite", "webpack", "parcel"].some((d) => deps.has(d))
      )
        signal("App", "strong", "index.html", "It is a bundled web page")
      const published =
        json.private !== true &&
        ["main", "module", "exports", "types", "publishConfig"].some(
          (key) => key in json,
        )
      if (published)
        signal(
          "Library",
          "strong",
          "package.json",
          "It is a package that other packages import",
        )
      if (json.bin)
        signal("Service", "weak", "package.json", "It has a command")
      if (typeof json.scripts?.start === "string")
        signal("Service", "weak", "package.json", "It has a start script")
    }
  }

  if (has("app.json") && parseJson(read("app.json"))?.expo)
    signal("App", "strong", "app.json", "It has an Expo app config")
  if (
    has("manifest.json") &&
    "manifest_version" in (parseJson(read("manifest.json")) ?? {})
  )
    signal("App", "strong", "manifest.json", "It is a browser extension")
  for (const path of [
    "tauri.conf.json",
    "src-tauri/tauri.conf.json",
    "capacitor.config.json",
    "capacitor.config.ts",
    "AndroidManifest.xml",
    "app/src/main/AndroidManifest.xml",
  ])
    if (has(path))
      signal("App", "strong", path, `It has ${posix.basename(path)}`)

  if (has("pubspec.yaml")) {
    const text = read("pubspec.yaml")
    name ??= safeName(/^name:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1])
    if (
      /^[ \t]+flutter:[ \t]*$/m.test(text) &&
      !/^[ \t]+plugin:[ \t]*$/m.test(text)
    )
      signal("App", "strong", "pubspec.yaml", "It is a Flutter app")
    else signal("Library", "weak", "pubspec.yaml", "It is a Dart package")
  }

  if (has("Cargo.toml")) {
    const text = read("Cargo.toml")
    const tables = tomlTables(text)
    const nameLine = (tables.get("package") ?? []).find((l) =>
      /^\s*name\s*=/.test(l),
    )
    name ??= safeName(/=\s*"([^"]*)"/.exec(nameLine ?? "")?.[1])
    if (/^[ \t]*\[\[bin\]\]/m.test(text) || has("src/main.rs"))
      signal("Service", "strong", "Cargo.toml", "The crate builds a binary")
    else if (tables.has("lib") || has("src/lib.rs"))
      signal("Library", "strong", "Cargo.toml", "The crate is a library")
  }

  if (has("go.mod")) {
    const module = /^module[ \t]+(\S+)/m.exec(read("go.mod"))?.[1] ?? ""
    const segments = module.split("/").filter((s) => !/^v\d+$/.test(s))
    name ??= safeName(segments.at(-1))
    const main = [...files].some(
      (f) =>
        f.startsWith(`${dir}cmd/`) && f.endsWith(".go") && !f.includes("_test"),
    )
    if (main || /^package main\b/m.test(has("main.go") ? read("main.go") : ""))
      signal("Service", "strong", "go.mod", "The module has a main package")
    else signal("Library", "weak", "go.mod", "The module has no main package")
  }

  for (const manifest of ["pyproject.toml", "requirements.txt"]) {
    if (!has(manifest)) continue
    const text = read(manifest)
    const specs = []
    if (manifest === "requirements.txt") specs.push(...text.split("\n"))
    else {
      const tables = tomlTables(text)
      for (const table of ["project", "tool.poetry"]) {
        const line = (tables.get(table) ?? []).find((l) =>
          /^\s*name\s*=/.test(l),
        )
        name ??= safeName(/=\s*"([^"]*)"/.exec(line ?? "")?.[1])
      }
      specs.push(...tomlStringArray(tables, "project", "dependencies"))
      for (const line of tables.get("tool.poetry.dependencies") ?? [])
        specs.push(line.split("=")[0])
      if (tables.has("project.scripts") || tables.has("tool.poetry.scripts"))
        signal("Service", "weak", manifest, "It has a command")
      else if (tables.has("project") || tables.has("tool.poetry"))
        signal("Library", "weak", manifest, "It is a Python package")
    }
    for (const spec of specs) {
      const dep = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/
        .exec(spec.replace(/#.*$/, ""))?.[1]
        ?.toLowerCase()
        .replace(/[_.]+/g, "-")
      if (dep && PYTHON_SERVER.has(dep))
        signal("Service", "strong", manifest, `It depends on ${dep}`)
    }
  }
  if (has("manage.py"))
    signal("Service", "strong", "manage.py", "It is a Django project")

  if (has("pom.xml")) {
    const text = read("pom.xml")
    if (
      text.includes("spring-boot-maven-plugin") ||
      /<packaging>\s*war\s*<\/packaging>/.test(text)
    )
      signal(
        "Service",
        "strong",
        "pom.xml",
        "It builds a Spring Boot or web application",
      )
    else signal("Library", "weak", "pom.xml", "It is a Maven package")
  }
  for (const gradle of ["build.gradle", "build.gradle.kts"]) {
    if (!has(gradle)) continue
    const text = read(gradle)
    if (text.includes("com.android.application"))
      signal("App", "strong", gradle, "It is an Android app")
    else if (/org\.springframework\.boot|\bapplication\b/.test(text))
      signal("Service", "strong", gradle, "It builds an application")
    else signal("Library", "weak", gradle, "It is a Gradle package")
  }

  for (const path of DEPLOY_FILES)
    if (has(path)) signal("Service", "strong", path, `It has ${path}`)
  for (const path of ["Dockerfile", "Containerfile"])
    if (has(path)) signal("Service", "weak", path, "It has a container image")

  return { name, signals }
}

/** The kind from the signals: { kind } or { options, reason }. */
export function decide(signals) {
  for (const strength of ["strong", "weak"]) {
    const kinds = [
      ...new Set(
        signals.filter((s) => s.strength === strength).map((s) => s.kind),
      ),
    ].sort()
    if (kinds.length === 1) return { kind: kinds[0] }
    if (kinds.length > 1)
      return {
        options: kinds,
        reason: `The ${strength} rules give more than one kind`,
      }
  }
  return { options: KINDS, reason: "No rule matched" }
}

/** Files that help the model choose: the manifests, README, and container files at the root. */
export function modelFiles(files, rootPath) {
  const dir = rootPath === "." ? "" : `${rootPath}/`
  return [...files]
    .filter((f) => f.startsWith(dir) && !f.slice(dir.length).includes("/"))
    .filter((f) =>
      /^(package\.json|Cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt|pom\.xml|build\.gradle(\.kts)?|pubspec\.yaml|app\.json|manifest\.json|Dockerfile|Containerfile|Procfile|README(\.[a-z]+)?|main\.[a-z]+|index\.[a-z]+)$/i.test(
        f.slice(dir.length),
      ),
    )
    .sort()
    .slice(0, 20)
}
