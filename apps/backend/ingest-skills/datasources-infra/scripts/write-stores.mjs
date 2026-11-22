#!/usr/bin/env node
// write-stores: turn the model's plan of the stores and the infrastructure
// into the staged tree. The model writes a plan (data only). This script runs
// the finder again, refuses a plan item whose id the finder did not list,
// checks the text of each item for values, and writes the files with the
// shared writer (new files, and additive updates of existing ones).
//
// node write-stores.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --source-path <path> --roots <root-to-file map> \
//   --plan /ctxpipe/home/stores-plan.json
//
// Plan (plan.schema.json): { "items": [{ "id": "Database:postgres", "name",
//   "role", "summary"?, "existing"?, "roots": [{ "root", "predicate",
//   "evidence"? }] }] }
//
// The cursor (CTX-1487) is `storeCursor` of stores-lib.mjs: the pairs of an
// id and a root that the finder lists, and which of them the tree has done.
// A pair that the model does not plan is never done.

import { readFileSync } from "node:fs"

import { plainText } from "../../apis/scripts/apis-lib.mjs"
import {
  findExisting,
  relativeTo,
  scriptStep,
  writeStep,
} from "../../bin/knowledge-lib.mjs"
import { fail } from "../../bin/stage-lib.mjs"
import {
  readTracked,
  safePath,
  trackedFiles,
} from "../../discover-roots/scripts/roots-lib.mjs"
import { STORES } from "./catalog.mjs"
import {
  markLine,
  findStores,
  rootLine,
  rootPathsOf,
  STORE_PREDICATES,
  storeCandidates,
  storeCursor,
  unitOf,
  refuseRootStep,
} from "./stores-lib.mjs"

const {
  rootsFile,
  step,
  source,
  repository,
  roots,
  index,
  skipped,
  value,
  rootPath,
} = scriptStep()
refuseRootStep(rootPath)
const planFile = value("--plan") ?? fail("Give --plan <plan file>")
const skip = (path, reason) => skipped.push({ path, reason })

const MAX_PLAN_BYTES = 256 * 1024
let plan
try {
  const text = readFileSync(planFile)
  if (text.length > MAX_PLAN_BYTES)
    fail(`${planFile} is larger than ${MAX_PLAN_BYTES} bytes`)
  plan = JSON.parse(text.toString("utf8"))
} catch {
  fail(`${planFile} is missing or is not valid JSON`)
}
if (!plan || typeof plan !== "object" || !Array.isArray(plan.items))
  fail(`${planFile} has no items list`)

const found = findStores({ index, source, rootsFile })
const candidates = storeCandidates(found)
const candidateById = new Map(candidates.map((c) => [c.id, c]))
const rootByPath = new Map(roots.map((r) => [r.path, r]))
const tracked = new Set(trackedFiles(source))

const ROLES = {
  Database: {
    primary: "Role: primary store for the domain data.",
    cache: "Role: cache.",
    session: "Role: session store.",
    search: "Role: search index.",
    analytics: "Role: analytics store.",
    "object-storage": "Role: object storage.",
    queue: "Role: queue or event store.",
    "local-development": "Role: only local development uses it.",
    test: "Role: only tests use it.",
    example: "Role: only examples or documentation use it.",
  },
  Infrastructure: {
    deploy: "Role: the repository deploys with it.",
    build: "Role: the build or the CI uses it.",
    "local-development": "Role: only local development uses it.",
    test: "Role: only tests use it.",
    example: "Role: only examples or documentation use it.",
  },
}

/** A config file: its values are data of the deploy, not names of code. */
const CONFIG_FILE =
  /^(\.env[\w.-]*|[\w.-]+\.(ya?ml|toml|ini|cfg|conf|properties|tfvars|tf|jsonc?))$/i
/** A manifest: its values are packages and versions, not data of the deploy. */
const MANIFEST = /^(package|composer)\.json$/i
/** The words of the catalog: the names of the stores, not values. */
const CATALOG_WORDS = new Set(
  STORES.flatMap((store) => [
    store.id,
    store.name,
    ...store.images,
    ...store.deps,
  ])
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean),
)

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

// --- values: the rules of SKILL.md that a script can check ------------------

/**
 * The values of the evidence files of a candidate, and of the `extra` files
 * that the plan gives as evidence. A value is the text after `=` or `:` of
 * each `key = value` or `"key": "value"` pair of a line, and its parts.
 * - `secrets`: the value of a credential field or of an identity field (a
 *   user, a host, a port, an account) of any length, the user and the
 *   password of a URL anywhere in a line (any length), and each other value
 *   or part with a character that is not a letter, or of 16 letters or more.
 *   A name and a summary must hold none of them.
 * - `words`: each word of each value of a config file (`.env`, YAML, TOML,
 *   INI, JSON; not a manifest such as package.json, and not code). A name and a summary must hold none of them.
 * A word of the catalog (`redis`, `postgres`) is the name of a store, not a
 * value, so neither set holds it.
 */
function evidenceValues(candidate, extra) {
  const secrets = new Set()
  const words = new Set()
  const paths = new Set([
    ...[...candidate.roots.values()].flat().map((e) => e.path),
    ...extra,
  ])
  for (const path of paths) {
    if (!safePath(path)) continue
    const name = path.split("/").pop() ?? ""
    const config = CONFIG_FILE.test(name) && !MANIFEST.test(name)
    for (const line of readTracked(source, path).split(/\r?\n/)) {
      // The user and the password of a URL (`scheme://user:password@host`).
      for (const userInfo of line.matchAll(/:\/\/([^\s/@"']+)@/g))
        for (const part of userInfo[1].split(":"))
          if (part && !CATALOG_WORDS.has(part.toLowerCase()))
            secrets.add(part.toLowerCase())
      for (const pair of line.matchAll(
        /["']?([A-Za-z_][\w.-]{0,100})["']?[ \t]*[=:][ \t]*("[^"]*"|'[^']*'|[^\s,;}]+)/g,
      )) {
        // A credential field: a key with `password`, `passwd`, `pwd`,
        // `secret`, `token`, or `credential` in any place (`PGPASSWORD`), or
        // with the whole word `pass`, `key`, or `auth` (`apiKey`,
        // `REDISCLI_AUTH`), so that `keywords` and `author` are not.
        const key = pair[1].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()
        const credential =
          /password|passwd|pwd|secret|token|credential/.test(key) ||
          /(^|[^a-z])(pass|key|apikey|auth|user|username|login|host|hostname|port|account)([^a-z]|$)/.test(
            key,
          )
        const raw = pair[2].replace(/^["']|["']$/g, "").trim()
        for (const part of [raw, ...raw.split(/[\s"'`,;:@/?&=]+/)]) {
          if (CATALOG_WORDS.has(part.toLowerCase())) continue
          if (
            (credential && part.length > 0) ||
            (part.length >= 6 && (/[^A-Za-z]/.test(part) || part.length >= 16))
          )
            secrets.add(part.toLowerCase())
        }
        if (config)
          for (const word of raw.toLowerCase().split(/[^a-z0-9]+/))
            if (word.length >= 2 && !CATALOG_WORDS.has(word)) words.add(word)
      }
    }
  }
  return { secrets, words }
}

/**
 * The reason why a text can hold a value (SKILL.md step 8), or null. A value
 * with only letters and digits counts as a whole word: `pg` is in "pg
 * driver", not in "upgrade". It also refuses each word of a config value.
 */
function valueReason(text, values) {
  if (/:\/\/|@|=/.test(text))
    return "it has a URL, an address, or an assignment"
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(text)) return "it has an IP address"
  if (/:\d{2,5}\b/.test(text)) return "it has a port"
  if (/\d{6,}/.test(text)) return "it has a long number, such as an account id"
  if (/\b[a-z0-9-]+(?:\.[a-z0-9-]+){2,}\b/i.test(text))
    return "it has a host name"
  if (
    /(?=[A-Za-z0-9_+/-]*\d)(?=[A-Za-z0-9_+/-]*[A-Za-z])[A-Za-z0-9_+/-]{20,}/.test(
      text,
    )
  )
    return "it has a token or a key"
  const words = text.toLowerCase().split(/[^a-z0-9]+/)
  const lower = text.toLowerCase()
  for (const value of values.secrets) {
    const word = /^[a-z0-9]+$/.test(value)
    if (word ? words.includes(value) : lower.includes(value))
      return "it has a value from an evidence file"
  }
  if (words.some((word) => values.words.has(word)))
    return "it has a word of a value of an evidence file"
  return null
}

// --- resolve each item of the plan ------------------------------------------

const entryByPath = new Map(index.map((entry) => [entry.path, entry]))
const resolved = []
/** The store file of each pair of an id and a root that the plan names. */
const planned = []
for (const input of plan.items) {
  const id = typeof input?.id === "string" ? input.id : null
  const candidate = id ? candidateById.get(id) : undefined
  if (!candidate) {
    skip(
      null,
      `${id && safePath(id) ? id : "A plan item"} is not an id that find-stores listed: the script writes no file for it`,
    )
    continue
  }
  const { kind } = candidate
  const values = evidenceValues(
    candidate,
    (Array.isArray(input.roots) ? input.roots : [])
      .map((use) => use?.evidence)
      .filter(
        (path) =>
          typeof path === "string" && safePath(path) && tracked.has(path),
      ),
  )
  // A name that the script refuses gives the name of the catalog, as a
  // summary does: the store keeps its file, and no value goes in.
  let name = typeof input.name === "string" ? input.name.trim() : ""
  const nameReason =
    !/^[\p{L}\p{N}][\p{L}\p{N} ._()&+,-]{0,79}$/u.test(name) || !slug(name)
      ? "it has characters that the script does not write"
      : valueReason(name, values)
  if (nameReason) {
    skip(
      null,
      `${id}: the script wrote the name ${candidate.name}, because ${nameReason}`,
    )
    name = candidate.name
  }
  const roleText =
    typeof input.role === "string" && Object.hasOwn(ROLES[kind], input.role)
      ? ROLES[kind][input.role]
      : null
  if (!roleText) {
    skip(
      null,
      `${id}: the role is not one of ${Object.keys(ROLES[kind]).join(", ")}`,
    )
    continue
  }
  let summary = `${candidate.name} that a source repository uses.`
  if (input.summary !== undefined) {
    const text = plainText(input.summary, 300)
    const reason = text
      ? valueReason(text, values)
      : "it has text that the script does not write"
    if (reason)
      skip(null, `${id}: the script wrote no summary, because ${reason}`)
    else summary = text
  }

  let path = null
  if (input.existing !== undefined && input.existing !== null) {
    const entry = entryByPath.get(input.existing)
    if (entry?.kind === kind && safePath(entry.path)) path = entry.path
    else
      skip(
        null,
        `${id}: existing is not a file of kind ${kind} in the context index`,
      )
  }
  path ??= findExisting(index, kind, [name])
  const isNew = path === null
  path ??= `knowledge/${kind === "Database" ? "databases" : "infrastructure"}/${slug(name)}.md`

  const claims = []
  const related = [markLine(repository, candidate)]
  const found = [...candidate.roots.values()].flat().map((e) => e.path)
  for (const use of Array.isArray(input.roots) ? input.roots : []) {
    const codeRoot = rootByPath.get(use?.root)
    if (!codeRoot) {
      skip(null, `${id}: a root of the plan is not a root of the map`)
      continue
    }
    if (!STORE_PREDICATES[kind].includes(use.predicate)) {
      skip(
        null,
        `${id}: the predicate for ${codeRoot.path} is not one of ${STORE_PREDICATES[kind].join(", ")}`,
      )
      continue
    }
    let evidence = null
    if (use.evidence === undefined) {
      const here = candidate.roots.get(codeRoot.path)?.[0]?.path
      if (here && safePath(here)) evidence = { path: here, kind: "script" }
    } else if (typeof use.evidence === "string" && safePath(use.evidence)) {
      if (found.includes(use.evidence))
        evidence = { path: use.evidence, kind: "script" }
      else if (tracked.has(use.evidence))
        evidence = { path: use.evidence, kind: "model" }
    }
    if (!evidence) {
      skip(
        null,
        `${id}: the use in ${codeRoot.path} has no evidence: give a tracked source file`,
      )
      continue
    }
    related.push(rootLine(repository, codeRoot.path))
    planned.push({ id, root: codeRoot.path, path })
    const unit = unitOf(roots, codeRoot.path)
    if (!unit) {
      skip(
        null,
        `${id}: ${codeRoot.path} has no one file of kind Service or App, so the script writes no claim`,
      )
      continue
    }
    claims.push({ from: unit, predicate: use.predicate, evidence })
  }
  resolved.push({ kind, name, path, isNew, roleText, summary, claims, related })
}

// --- plans for the shared writer ------------------------------------------------

const plans = []
for (const item of resolved) {
  plans.push({
    path: item.path,
    ...(item.isNew ? { expectName: item.name } : {}),
    create: {
      kind: item.kind,
      name: item.name,
      summary: item.summary,
      intro: `${item.roleText} ${item.summary}`,
    },
    claims: [],
    related: item.related,
  })
  for (const claim of item.claims)
    plans.push({
      path: claim.from,
      create: null,
      related: [],
      claims: [
        {
          to: relativeTo(claim.from, item.path),
          predicate: claim.predicate,
          evidence: claim.evidence,
        },
      ],
    })
}

writeStep(step, plans, skipped, {
  cursorAt: () =>
    storeCursor({
      step,
      repository,
      index,
      roots,
      candidates,
      rootPaths: rootPathsOf(found),
      planned,
    }).at,
})
