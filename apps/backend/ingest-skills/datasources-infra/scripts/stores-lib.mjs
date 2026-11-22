// The finder of the datasources-infra skill. It reads the roots of the source
// repository and lists the data stores and the infrastructure that the files
// show. It writes nothing. find-stores.mjs prints its result for the model,
// and write-stores.mjs runs it again to check the plan of the model.
//
// The skill runs only in the repository-wide step. The result is
// `{ roots: [{ root, stores, infrastructure }], skipped }`, one entry for each
// root of the map, from one read of the source, so that the skill writes the
// shared Database and Infrastructure files once (ADR-052 section 6).
//
// Each store and each infrastructure kind has an `id`: `<kind>:<type>`, for
// example `Database:postgres`. The inputs of the cursor (CTX-1487) are the
// pairs of an id and a root that the result lists, sorted by id and then by
// root (`storeCandidates`). Their number depends only on the source and on
// the root paths of the map, so it is the same on each page of the skill.
//
// The source repository is hostile. The result holds only words from
// catalog.mjs and safe identifiers (a variable name, a resource label, a
// path). It never holds a value: not a connection string, a host, a user, a
// password, a key, or any other text from a file.

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { posix } from "node:path"

import {
  fileClaims,
  frontMatter,
  frontValue,
  nameKey,
  relativeTo,
} from "../../bin/knowledge-lib.mjs"
import {
  baseBlob,
  blobContent,
  fail,
  stagedFile,
  stagedPaths,
} from "../../bin/stage-lib.mjs"
import {
  inTestFixture,
  safePath,
  testFixtureSkips,
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

// Byte limits that protect the process. Neither drops input in silence:
// each one gives a `skipped` entry. The finder has no count limit
// (CTX-1487): the cursor bounds the pages.
const MAX_FILE_BYTES = 256 * 1024
const MAX_LINE = 2000

/** A variable name, a resource label, a service name: letters, digits, and a few separators. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,59}$/
const IGNORED_SEGMENTS = new Set(["node_modules", "vendor", "third_party"])

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

/** The skill runs only in the repository-wide step: refuse a root step. */
export function refuseRootStep(rootPath) {
  if (rootPath !== null)
    fail(
      "datasources-infra runs only in the repository-wide step: give no --path",
    )
}

/** The id of a store or an infrastructure kind: `<kind>:<type>`. */
export const storeId = (kind, type) => `${kind}:${type}`

/**
 * The stores and the infrastructure of the roots, as find-stores.mjs prints
 * them. `index` is the context index of the step (for `existing`), and
 * `rootsFile` the root-to-file map.
 */
export function findStores({ index, source, rootsFile }) {
  let listed = []
  try {
    listed = JSON.parse(readFileSync(rootsFile, "utf8")).roots
  } catch {
    fail(`${rootsFile} is not a roots file`)
  }
  if (!Array.isArray(listed)) fail(`${rootsFile} has no roots list`)
  const tracked = trackedFiles(source)
  const deeperRoots = (path) => deeperRootsOf(listed, path)
  const storesOf = (path) =>
    storesOfRoot({ path, source, tracked, index, deeperRoots })
  const roots = []
  const skipped = []
  for (const entry of listed) {
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
  return { roots, skipped }
}

/**
 * The distinct ids of the result, sorted by id. Each one has `{ id, kind,
 * type, name, roots }`; `roots` maps a root path to the evidence of the id in
 * that root, in the order of the map.
 */
export function storeCandidates(result) {
  const byId = new Map()
  for (const root of result.roots) {
    for (const [kind, entries] of [
      ["Database", root.stores],
      ["Infrastructure", root.infrastructure],
    ]) {
      for (const entry of entries) {
        let candidate = byId.get(entry.id)
        if (!candidate) {
          candidate = {
            id: entry.id,
            kind,
            type: entry.type,
            name: entry.name,
            roots: new Map(),
          }
          byId.set(entry.id, candidate)
        }
        candidate.roots.set(root.root, entry.evidence)
      }
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
}

/**
 * The root paths of the result, in the order of the map. The inputs of the
 * cursor are the pairs of an id of `storeCandidates` and each of these roots:
 * a root can use a store that the finder found in another root (a shared
 * library), and the writer takes its claim with model evidence.
 */
export const rootPathsOf = (result) => result.roots.map((r) => r.root)

/** The number of inputs of the cursor: each id with each root. */
export const cursorLength = (result) =>
  storeCandidates(result).length * result.roots.length

/** Paths of the roots below `rootPath`: their files belong to their own steps. */
function deeperRootsOf(listed, rootPath) {
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
function storesOfRoot({ path: rootPath, source, tracked, index, deeperRoots }) {
  const skipped = []
  const seenSkips = new Set()
  const skip = (path, reason) => {
    const entry = { path: path && safePath(path) ? path : null, reason }
    const key = `${entry.path} ${reason}`
    if (seenSkips.has(key)) return
    seenSkips.add(key)
    skipped.push(entry)
  }

  const deeper = deeperRoots(rootPath)
  const listed = tracked.filter((file) => {
    if (rootPath !== "." && !file.startsWith(`${rootPath}/`)) return false
    if (deeper.some((d) => file.startsWith(`${d}/`))) return false
    // A dot folder (.github, .circleci, .devcontainer) is tooling, not the product.
    return !file
      .split("/")
      .slice(0, -1)
      .some((s) => s.startsWith(".") || IGNORED_SEGMENTS.has(s))
  })
  for (const { path, reason } of testFixtureSkips(listed)) skip(path, reason)
  const inRoot = listed.filter((file) => !inTestFixture(file))

  /** Text of a tracked file at HEAD, or null (and a `skipped` entry when the cause is a limit). */
  function read(path) {
    if (!safePath(path)) {
      skip(null, "A file path has characters that the script does not quote")
      return null
    }
    try {
      const text = execFileSync("git", ["-C", source, "show", `HEAD:${path}`], {
        maxBuffer: MAX_FILE_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString("utf8")
      if (text.split(/\r?\n/).some((line) => line.length > MAX_LINE))
        skip(
          path,
          `The script read only the first ${MAX_LINE} characters of each line`,
        )
      return text
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

  /** Key "kind:id" to { kind, id, evidence, seen }: all the evidence. */
  const items = new Map()
  function add(kind, id, path, rule, detail) {
    const key = storeId(kind, id)
    let item = items.get(key)
    if (!item) {
      item = { kind, id, evidence: [], seen: new Set() }
      items.set(key, item)
    }
    const same = `${path}\0${rule}\0${detail ?? ""}`
    if (item.seen.has(same)) return
    item.seen.add(same)
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
        id: storeId("Database", store.id),
        type: store.id,
        name: store.name,
        category: store.category,
        evidence: item.evidence,
        evidenceTotal: item.evidence.length,
        existing: existing("Database", [store.name, store.id]),
      })
    } else {
      const name = INFRA[item.id]
      out.infrastructure.push({
        id: storeId("Infrastructure", item.id),
        type: item.id,
        name,
        evidence: item.evidence,
        evidenceTotal: item.evidence.length,
        existing: existing("Infrastructure", [name, item.id]),
      })
    }
  }
  return out
}

// --- the cursor: what the tree of the step has --------------------------------

/** The predicates of a root claim to a file of each kind. */
export const STORE_PREDICATES = {
  Database: ["READS_FROM", "WRITES_TO", "DEPENDS_ON"],
  Infrastructure: ["RUNS_ON"],
}

/** The start of the line that marks a store file as a file of `type`. */
export const declares = (repository, type) =>
  `- \`${repository}\` declares \`${type}\``

/** The line of the id in a store file: `declares`, with the first evidence file of the id. */
export function markLine(repository, candidate) {
  const evidence = [...candidate.roots.values()].flat()[0]
  const where =
    evidence && safePath(evidence.path) ? ` in \`${evidence.path}\`` : ""
  return `${declares(repository, candidate.type)}${where}`
}

/** The line of a store file for a root that uses the store. */
export const rootLine = (repository, path) =>
  `- \`${repository}\` uses it in \`${path}\``

/** The one file of kind Service or App of a root of `scriptStep`, or null. */
export function unitOf(roots, path) {
  const units = (roots.find((r) => r.path === path)?.files ?? []).filter(
    (f) => f.kind === "Service" || f.kind === "App",
  )
  return units.length === 1 ? units[0].path : null
}

/** The text of a context file in the staged tree, else at the step base. */
function textOf(step, path) {
  try {
    return readFileSync(stagedFile(step, path), "utf8")
  } catch {}
  const blob = baseBlob(step, path)
  return blob ? blobContent(step, blob).toString("utf8") : null
}

/**
 * The cursor of the step (CTX-1487): `{ at, of, waiting }`. The inputs are
 * the pairs of an id of `candidates` and a root of `rootPaths`. A pair that
 * no root uses is never done, so `at` stays below `of`, and the pages end
 * when the model stops saying `more`. A store file serves a pair
 * when the tree (the staged tree, else the step base) has it with the kind
 * of the id, and:
 * - when the root has one Service or App file, that file has a claim to the
 *   store file;
 * - else, the store file has the line of the root (`rootLine`).
 * A pair expects each store file of its id (with the line of the id,
 * `declares`) that has the line of its root. The writer writes the store
 * file before the claim, so the tree keeps what a pair expects across
 * pages. `planned` adds the store files of the writer's plan for each pair
 * (`{ id, root, path }`), also before they are in the tree.
 * - A pair that expects files is done when each one serves it. One engine
 *   can have two stores. A new store of an engine waits until its own claims
 *   are in the tree, also on a next page with an empty plan.
 * - A pair that expects no file is done when a store file of its id serves
 *   it (a claim that a person or an earlier run wrote).
 * The test reads the tree, and a page only adds to it, so a pair that is
 * done stays done. On a re-ingestion, a store that a root claims already is
 * done on the first page. `waiting` lists the pairs that are not done.
 */
export function storeCursor({
  step,
  repository,
  index,
  roots,
  candidates,
  rootPaths,
  planned = [],
}) {
  // Each store file once: its kind, the types of its lines of an id, and
  // its lines.
  const head = `- \`${repository}\` declares \``
  const stores = new Map()
  for (const path of new Set([
    ...index
      .filter((e) => e.kind === "Database" || e.kind === "Infrastructure")
      .map((e) => e.path),
    ...stagedPaths(step),
    ...planned.map((p) => p.path),
  ])) {
    if (!safePath(path) || !path.startsWith("knowledge/")) continue
    const text = textOf(step, path)
    const kind = text && frontValue(frontMatter(text) ?? "", "kind")
    if (kind !== "Database" && kind !== "Infrastructure") continue
    const lines = new Set(text.split("\n").map((l) => l.trimEnd()))
    const types = new Set()
    for (const line of lines)
      if (line.startsWith(head)) {
        const type = line.slice(head.length).split("`")[0]
        const rest = line.slice(head.length + type.length + 1)
        if (rest === "" || rest.startsWith(" in ")) types.add(type)
      }
    stores.set(path, { path, kind, lines, types })
  }
  const plannedOf = new Map()
  for (const p of planned) {
    const key = `${p.id} ${p.root}`
    plannedOf.set(key, [...(plannedOf.get(key) ?? []), p.path])
  }
  const claimsOf = new Map()
  const serves = (file, candidate, codeRoot) => {
    if (!file || file.kind !== candidate.kind) return false
    const unit = unitOf(roots, codeRoot)
    if (!unit) return file.lines.has(rootLine(repository, codeRoot))
    if (!claimsOf.has(unit)) {
      const text = textOf(step, unit)
      claimsOf.set(unit, text === null ? null : fileClaims(text))
    }
    const claims = claimsOf.get(unit)
    return STORE_PREDICATES[candidate.kind].some((p) =>
      claims?.has(`${relativeTo(unit, file.path)} ${p}`),
    )
  }
  const waiting = []
  let at = 0
  for (const candidate of candidates) {
    const marked = [...stores.values()].filter(
      (f) => f.kind === candidate.kind && f.types.has(candidate.type),
    )
    for (const codeRoot of rootPaths) {
      const line = rootLine(repository, codeRoot)
      const expected = new Set([
        ...marked.filter((f) => f.lines.has(line)).map((f) => f.path),
        ...(plannedOf.get(`${candidate.id} ${codeRoot}`) ?? []),
      ])
      const done =
        expected.size > 0
          ? [...expected].every((path) =>
              serves(stores.get(path), candidate, codeRoot),
            )
          : marked.some((f) => serves(f, candidate, codeRoot))
      if (done) at++
      else waiting.push({ id: candidate.id, root: codeRoot })
    }
  }
  return { at, of: candidates.length * rootPaths.length, waiting }
}
