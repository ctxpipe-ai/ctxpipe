#!/usr/bin/env node
// find-stores: the script half of the datasources-infra skill. It reads one
// root of the source repository and lists the data stores and the
// infrastructure that the files show. It writes nothing. The model resolves
// the role of each store and writes the knowledge files.
//
// node find-stores.mjs --source /ctxpipe/source/<handle> --source-url <url> \
//   --roots <root-to-file map> [--path <root path>] [--root /ctxpipe]
//
// With --path (a root step): the stores of that root. Without --path (the
// repository-wide step): `{ roots: [{ root, stores, infrastructure }] }`, one
// entry for each root of the map, from one read of the source, so that the
// agent writes the shared Database and Infrastructure files once (ADR-052
// section 6).
//
// The source repository is hostile. The result holds only words from
// catalog.mjs and safe identifiers (a variable name, a resource label, a
// path). It never holds a value: not a connection string, a host, a user, a
// password, a key, or any other text from a file.

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, posix } from "node:path"
import { nameKey, stepArgs } from "../../bin/knowledge-lib.mjs"
import { fail } from "../../bin/stage-lib.mjs"
import {
  safePath,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"
import {
  CDK_COMPUTE,
  CDK_STORES,
  engineToStore,
  IAC_STORES,
  INFRA,
  INFRA_FILES,
  STORES,
  TERRAFORM_COMPUTE,
} from "./catalog.mjs"

const MAX_FILE_BYTES = 256 * 1024
const MAX_READ_FILES = 1500
const MAX_CDK_FILES = 300
const MAX_LINE = 2000
const MAX_EVIDENCE = 8
const MAX_ITEMS = 60
const MAX_SKIPPED = 20
const MAX_EXISTING = 5

/** A variable name, a resource label, a service name: letters, digits, and a few separators. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,59}$/
const IGNORED_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  "third_party",
  "testdata",
  "fixtures",
  "__fixtures__",
])

const storeById = new Map(STORES.map((s) => [s.id, s]))
const depToStore = new Map()
const schemeToStore = new Map()
const imageToStore = new Map()
const ormToStore = new Map()
for (const store of STORES) {
  for (const dep of store.deps) depToStore.set(dep.toLowerCase(), store.id)
  for (const scheme of store.schemes) schemeToStore.set(scheme, store.id)
  for (const image of store.images) imageToStore.set(image, store.id)
  for (const token of store.orm) ormToStore.set(token, store.id)
}

const { root: stageRoot, source, rootsFile, rootPath } = stepArgs()
let listed = []
try {
  listed = JSON.parse(readFileSync(rootsFile, "utf8")).roots
} catch {
  fail(`${rootsFile} is not a roots file`)
}
if (!Array.isArray(listed)) fail(`${rootsFile} has no roots list`)
const tracked = trackedFiles(source)

/** Paths of the roots below `rootPath`: their files belong to their own steps. */
function deeperRoots(rootPath) {
  return listed
    .map((r) => r?.path)
    .filter(
      (p) =>
        typeof p === "string" &&
        safePath(p) &&
        p !== "." &&
        p !== rootPath &&
        (rootPath === "." || p.startsWith(`${rootPath}/`)),
    )
}

/** The stores and infrastructure of one root. */
function storesOf(rootPath) {
  const skipped = []
  const skip = (path, reason) => {
    if (skipped.length < MAX_SKIPPED)
      skipped.push({ path: path && safePath(path) ? path : null, reason })
  }

  const deeper = deeperRoots(rootPath)
  const inRoot = tracked.filter((file) => {
    if (rootPath !== "." && !file.startsWith(`${rootPath}/`)) return false
    if (deeper.some((d) => file.startsWith(`${d}/`))) return false
    // A dot folder (.github, .circleci, .devcontainer) is tooling, not the product.
    return !file
      .split("/")
      .slice(0, -1)
      .some((s) => s.startsWith(".") || IGNORED_SEGMENTS.has(s))
  })

  let readFiles = 0
  /** Text of a tracked file at HEAD, or null (and a `skipped` entry when the cause is a limit). */
  function read(path) {
    if (!safePath(path)) {
      skip(null, "A file path has characters that the script does not quote")
      return null
    }
    if (readFiles >= MAX_READ_FILES) {
      if (readFiles === MAX_READ_FILES) {
        readFiles++
        skip(null, `The script read only the first ${MAX_READ_FILES} files`)
      }
      return null
    }
    readFiles++
    try {
      return execFileSync("git", ["-C", source, "show", `HEAD:${path}`], {
        maxBuffer: MAX_FILE_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString("utf8")
    } catch (error) {
      if (error?.code === "ENOBUFS")
        skip(path, `The file is larger than ${MAX_FILE_BYTES / 1024} KiB`)
      return null
    }
  }

  /** Lines of a text, each cut at MAX_LINE so that no pattern runs long on a minified line. */
  const lines = (text) =>
    text
      .split(/\r?\n/)
      .map((line) => (line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line))

  /** Key "kind:id" to { kind, id, evidence, total }. */
  const items = new Map()
  let itemsFull = false
  function add(kind, id, path, rule, detail) {
    const key = `${kind}:${id}`
    let item = items.get(key)
    if (!item) {
      if (items.size >= MAX_ITEMS) {
        if (!itemsFull) {
          itemsFull = true
          skip(null, `The script lists at most ${MAX_ITEMS} stores and kinds`)
        }
        return
      }
      item = { kind, id, evidence: [], total: 0 }
      items.set(key, item)
    }
    const same = item.evidence.some(
      (e) => e.path === path && e.rule === rule && e.detail === detail,
    )
    if (same) return
    item.total++
    if (item.evidence.length < MAX_EVIDENCE)
      item.evidence.push({ path, rule, ...(detail ? { detail } : {}) })
  }
  const addStore = (id, path, rule, detail) =>
    storeById.has(id) && add("Database", id, path, rule, detail)
  const addInfra = (id, path, rule, detail) =>
    add("Infrastructure", id, path, rule, detail)

  const base = (path) => posix.basename(path)

  // --- Manifests: a driver in the dependencies. ---

  const MANIFESTS = new Set([
    "package.json",
    "pyproject.toml",
    "pipfile",
    "go.mod",
    "cargo.toml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "gemfile",
    "composer.json",
    "mix.exs",
  ])
  const isRequirements = (name) => /^requirements[\w.-]*\.txt$/.test(name)

  function manifestDeps(name, text) {
    const found = new Set()
    if (name === "package.json" || name === "composer.json") {
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        return found
      }
      const keys =
        name === "package.json"
          ? ["dependencies", "peerDependencies", "optionalDependencies"]
          : ["require"]
      for (const key of keys)
        for (const dep of Object.keys(json?.[key] ?? {}))
          found.add(dep.toLowerCase())
      return found
    }
    for (const line of lines(text)) {
      for (const token of line.toLowerCase().matchAll(/[a-z0-9_.@/-]+/g)) {
        found.add(token[0])
        // A Go major version: github.com/jackc/pgx/v5
        found.add(token[0].replace(/\/v\d+$/, ""))
      }
    }
    return found
  }

  const cdkDirs = new Set()
  for (const file of inRoot) {
    const name = base(file).toLowerCase()
    if (!MANIFESTS.has(name) && !isRequirements(name)) continue
    const text = read(file)
    if (text === null) continue
    const deps = manifestDeps(name, text)
    for (const dep of deps) {
      const id = depToStore.get(dep)
      if (id) addStore(id, file, "manifest-dependency", dep)
    }
    if (deps.has("aws-cdk-lib") || deps.has("aws_cdk_lib"))
      cdkDirs.add(posix.dirname(file))
  }

  // --- Config files: connection schemes (names only), ORM config. ---

  const CONFIG_FILE =
    /^(\.env[\w.-]*|[\w.-]+\.(properties|ini|cfg|conf|toml|tfvars|ya?ml)|appsettings[\w.-]*\.json|schema\.prisma|drizzle\.config\.\w+|(settings|base|production)[\w.-]*\.py)$/i
  const SCHEME =
    /(?:^|[\s"'=:(])(?:jdbc:)?([a-z][a-z0-9+.-]{1,20}):\/\/(?=\S)/gi
  const VARIABLE_BEFORE =
    /(?:^|[\s"',{])(?:export\s+)?([A-Z][A-Z0-9_]*)\s*[=:]\s*["']?(?:jdbc:)?$/

  function scanConfig(path, text) {
    const name = base(path)
    for (const line of lines(text)) {
      for (const match of line.matchAll(SCHEME)) {
        const id = schemeToStore.get(match[1].toLowerCase())
        if (!id) continue
        // Only the variable name before the scheme. Never what follows it.
        const before = line.slice(0, match.index + match[0].indexOf(match[1]))
        const variable = VARIABLE_BEFORE.exec(before)?.[1]
        addStore(
          id,
          path,
          "connection-scheme",
          variable && ENV_NAME.test(variable) ? variable : undefined,
        )
      }
    }
    const orm = (pattern) => {
      for (const m of text.matchAll(pattern)) {
        const id = ormToStore.get(m[1])
        if (id) addStore(id, path, "orm-config", m[1])
      }
    }
    if (name === "schema.prisma") orm(/^\s*provider\s*=\s*"([a-z]+)"/gm)
    else if (/^drizzle\.config\.\w+$/.test(name))
      orm(/\bdialect:\s*["']([a-z]+)["']/g)
    else if (name === "database.yml")
      orm(/^\s*adapter:\s*["']?([a-z0-9_-]+)["']?\s*$/gm)
    else if (name.endsWith(".py")) orm(/django\.db\.backends\.([a-z0-9_]+)/g)
  }

  // --- Compose, Kubernetes, Helm values: images and the files themselves. ---

  const isCompose = (path) =>
    /^(docker-)?compose(\.[\w.-]+)?\.ya?ml$/i.test(base(path))
  const hasApiVersion = (text) => /^\s*apiVersion:\s*\S+/m.test(text)

  /** The image name without registry, tag, and digest; null when the text is not a plain image. */
  function imageName(raw) {
    const clean = raw.trim().replace(/^["']|["']$/g, "")
    // user:password@host/image is a credential, not an image.
    if (clean.includes("@") && !clean.includes("@sha256:")) return null
    const name = clean.split("@")[0].split("/").pop()?.split(":")[0]
    return name && /^[a-z0-9][a-z0-9._-]{0,60}$/.test(name) ? name : null
  }

  function scanDeployYaml(path, text) {
    const compose = isCompose(path)
    if (compose) addInfra("docker-compose", path, "iac-file")
    else if (
      hasApiVersion(text) &&
      /^\s*kind:\s*(Deployment|StatefulSet|DaemonSet|CronJob|Job|Ingress|Pod|Service)\s*$/m.test(
        text,
      )
    )
      addInfra("kubernetes", path, "iac-file")
    let service = null
    for (const line of lines(text)) {
      const top = /^ {2}([A-Za-z0-9][A-Za-z0-9_.-]{0,99}):\s*$/.exec(line)
      if (top) service = top[1]
      const image = /^\s*-?\s*image:\s*(\S+)\s*$/.exec(line)
      if (!image) continue
      const id = imageToStore.get(imageName(image[1]) ?? "")
      if (id)
        addStore(
          id,
          path,
          compose ? "compose-image" : "manifest-image",
          compose && service && SAFE_NAME.test(service) ? service : undefined,
        )
    }
  }

  // --- Terraform, CloudFormation, SAM, Helm. ---

  function resolveEngine(block, spec) {
    if (!spec.engine) return spec.fallback
    for (const line of block) {
      const m = /^\s*(?:engine|database_version)\s*=\s*"([^"]{1,60})"/.exec(
        line,
      )
      if (m) return engineToStore(m[1]) ?? spec.fallback
    }
    return spec.fallback
  }

  function scanTerraform(path, text) {
    addInfra("terraform", path, "iac-file")
    const all = lines(text)
    for (let i = 0; i < all.length; i++) {
      const m = /^\s*resource\s+"([a-z0-9_]+)"\s+"([A-Za-z0-9_-]+)"/.exec(
        all[i],
      )
      if (!m) continue
      const [, type, label] = m
      const spec = IAC_STORES[type]
      if (spec) {
        const block = []
        for (let j = i + 1; j < all.length && j < i + 80; j++) {
          if (/^\}/.test(all[j]) || /^\s*resource\s/.test(all[j])) break
          block.push(all[j])
        }
        addStore(
          resolveEngine(block, spec),
          path,
          "terraform-resource",
          `${type}.${label}`,
        )
      } else if (TERRAFORM_COMPUTE.has(type))
        addInfra("terraform", path, "terraform-resource", `${type}.${label}`)
    }
  }

  function scanCloudFormation(path, text) {
    const sam = /^\s*Transform:.*AWS::Serverless/m.test(text)
    addInfra(sam ? "aws-sam" : "aws-cloudformation", path, "iac-file")
    const all = lines(text)
    for (let i = 0; i < all.length; i++) {
      const type = /["']?Type["']?\s*:\s*["']?(AWS::[A-Za-z0-9:]+)["']?/.exec(
        all[i],
      )?.[1]
      const spec = type && Object.hasOwn(IAC_STORES, type) && IAC_STORES[type]
      if (!spec) continue
      const engine = all
        .slice(i + 1, i + 40)
        .map(
          (l) =>
            /^\s*["']?Engine["']?\s*:\s*["']?([A-Za-z0-9-]{1,60})/.exec(l)?.[1],
        )
        .find(Boolean)
      const id =
        spec.engine && engine
          ? (engineToStore(engine) ?? spec.fallback)
          : spec.fallback
      addStore(id, path, "cloudformation-resource", type)
    }
  }

  function scanHelm(path, text) {
    addInfra("helm", path, "iac-file")
    let inDependencies = false
    for (const line of lines(text)) {
      if (/^dependencies:/.test(line)) inDependencies = true
      else if (/^\S/.test(line)) inDependencies = false
      if (!inDependencies) continue
      const dep = /^\s*-?\s*name:\s*["']?([A-Za-z0-9._-]{1,60})["']?\s*$/.exec(
        line,
      )?.[1]
      const id = dep && imageToStore.get(dep.toLowerCase())
      if (id) addStore(id, path, "helm-dependency", dep.toLowerCase())
    }
  }

  const isDockerfile = (name) =>
    name === "dockerfile" ||
    name.startsWith("dockerfile.") ||
    name.endsWith(".dockerfile")

  // --- CDK: constructs in the source files of a CDK project. ---

  function scanCdk(path, text) {
    if (!/aws-cdk-lib|aws_cdk|software\.amazon\.awscdk|Amazon\.CDK/.test(text))
      return
    for (const line of lines(text)) {
      for (const m of line.matchAll(
        /\b([a-z_][A-Za-z0-9_]{0,20})\.([A-Z][A-Za-z0-9]{0,60})\s*\(/g,
      )) {
        const construct = `${m[1]}.${m[2]}`
        if (Object.hasOwn(CDK_STORES, construct)) {
          let id = CDK_STORES[construct]
          const engine = /Engine\.([A-Za-z0-9_]+)/.exec(line)?.[1]
          if (engine && id === "relational-database")
            id = engineToStore(engine) ?? id
          addStore(id, path, "cdk-construct", construct)
        } else if (CDK_COMPUTE.has(construct))
          addInfra("aws-cdk", path, "cdk-construct", construct)
      }
    }
  }

  // --- Walk the files. ---

  const YAML = /\.ya?ml$/
  const TEMPLATE_JSON =
    /(template|cloudformation|cfn|stack)[\w.-]*\.(json|template)$/
  for (const file of inRoot) {
    const name = base(file).toLowerCase()
    const kind = Object.hasOwn(INFRA_FILES, name) ? INFRA_FILES[name] : null
    if (isDockerfile(name)) addInfra("docker", file, "iac-file")
    if (kind === "helm") {
      const text = read(file)
      if (text !== null) scanHelm(file, text)
      continue
    }
    if (kind) addInfra(kind, file, "iac-file")
    if (kind === "aws-cdk") cdkDirs.add(posix.dirname(file))
    const terraform = name.endsWith(".tf")
    const config = CONFIG_FILE.test(base(file))
    const template = TEMPLATE_JSON.test(name)
    if (!terraform && !config && !template) continue
    const text = read(file)
    if (text === null) continue
    if (terraform) scanTerraform(file, text)
    if (
      (YAML.test(name) || template) &&
      /AWSTemplateFormatVersion|^\s*Transform:.*AWS::Serverless/m.test(text)
    )
      scanCloudFormation(file, text)
    if (YAML.test(name) && (isCompose(file) || hasApiVersion(text)))
      scanDeployYaml(file, text)
    if (config || terraform) scanConfig(file, text)
  }

  let cdkRead = 0
  if (cdkDirs.size) {
    for (const file of inRoot) {
      if (!/\.(ts|js|mjs|py|java|cs)$/.test(file) || /\.d\.ts$/.test(file))
        continue
      const dir = posix.dirname(file)
      if (
        ![...cdkDirs].some(
          (d) => d === "." || dir === d || dir.startsWith(`${d}/`),
        )
      )
        continue
      if (++cdkRead > MAX_CDK_FILES) {
        skip(
          null,
          `The script read only the first ${MAX_CDK_FILES} CDK source files`,
        )
        break
      }
      const text = read(file)
      if (text !== null) scanCdk(file, text)
    }
  }

  /** Index entries of the kind whose title holds one of the names: "Orders PostgreSQL" holds "postgresql". */
  function existing(kind, names) {
    const keys = names.map(nameKey).filter(Boolean)
    return index
      .filter(
        (e) =>
          e.kind === kind &&
          safePath(e.path) &&
          keys.some((k) => nameKey(e.title).includes(k)),
      )
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .slice(0, MAX_EXISTING)
      .map((e) => ({
        path: e.path,
        ...(typeof e.title === "string" && safePath(e.title)
          ? { title: e.title }
          : {}),
        owned: e.owned === true,
      }))
  }

  const out = { root: rootPath, stores: [], infrastructure: [], skipped }
  const sorted = [...items.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
  for (const item of sorted) {
    if (item.kind === "Database") {
      const store = storeById.get(item.id)
      out.stores.push({
        type: store.id,
        name: store.name,
        category: store.category,
        evidence: item.evidence,
        evidenceTotal: item.total,
        existing: existing("Database", [store.name, store.id]),
      })
    } else {
      const name = INFRA[item.id]
      out.infrastructure.push({
        type: item.id,
        name,
        evidence: item.evidence,
        evidenceTotal: item.total,
        existing: existing("Infrastructure", [name, item.id]),
      })
    }
  }
  return out
}

function readIndex() {
  const stepFile = join(stageRoot, "step.json")
  if (!existsSync(stepFile)) return []
  try {
    const { workspaceId } = JSON.parse(readFileSync(stepFile, "utf8"))
    if (
      typeof workspaceId !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(workspaceId)
    )
      return []
    const file = join(stageRoot, "context", `${workspaceId}.index.json`)
    const entries = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8")).entries
      : []
    return Array.isArray(entries) ? entries : []
  } catch {
    return []
  }
}
const index = readIndex()

if (rootPath === null) {
  // The repository-wide step: the stores of each root of the map, in this
  // one run, so that the agent writes the shared Database and Infrastructure
  // files once (ADR-052 section 6).
  const roots = []
  const skipped = []
  for (const entry of listed.slice(0, 400)) {
    const path = entry?.path
    if (typeof path !== "string" || (path !== "." && !safePath(path))) {
      skipped.push({
        path: null,
        reason: "A root path has characters that the script does not quote",
      })
      continue
    }
    roots.push(storesOf(path))
  }
  process.stdout.write(`${JSON.stringify({ roots, skipped })}\n`)
} else process.stdout.write(`${JSON.stringify(storesOf(rootPath))}\n`)
