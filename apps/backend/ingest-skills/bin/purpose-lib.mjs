// The purpose of one code root for the classify-kind and repository skills
// (CTX-1514): one or two sentences that say what the package does. The
// script reads, in this order: the description of a manifest (package.json,
// Cargo.toml, pyproject.toml), the doc comment of the package (the Go
// comment above the `package` clause, the Rust `//!` lines or `/*!` block of
// src/lib.rs or src/main.rs), and the first paragraph of the README. When no
// file gives one, the model of classify-kind writes it.
import { posix } from "node:path"

import {
  readTracked,
  tomlTables,
} from "../discover-roots/scripts/roots-lib.mjs"

/**
 * A URL as the host validator finds one in Markdown text: a scheme URL, a
 * `www.` host, or a `//host.tld` link. The host allows an external link only
 * to a repository of the Workspace, so a script keeps no URL as a link.
 */
export const EXTERNAL_URL =
  /\b(?:https?|ftp|file):\/\/[^\s`]+|(?<![\w.@/:-])www\.[^\s`]+|(?<![\w/:])\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s`]*/gi

/**
 * The phrases that the host validator reads as an instruction to an agent
 * (`INJECTION_PHRASES` of patch-validator.ts; a test keeps the two lists the
 * same). The validator refuses a file whose front matter holds one, so a
 * purpose with one is not used (CTX-1536).
 */
export const INJECTION_PHRASES = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|all|any|your|the)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules|directives|guidelines)\b/i,
  /\byou are (?:now|no longer)\b/i,
  /\b(?:new|updated|real|actual) (?:system )?instructions?\s*:/i,
  /\bsystem prompt\b/i,
  /\b(?:reveal|print|show|output|leak|exfiltrate|send|upload)\b[^.\n]{0,40}\b(?:system prompt|api[_ -]?keys?|credentials?|secrets?|access tokens?|passwords?)\b/i,
  /\b(?:do not|don't|never) (?:tell|inform|alert) (?:the )?(?:user|human|operator)\b/i,
  /\bas an ai\b/i,
  /\b(?:ai|llm|coding) (?:agents?|assistants?|models?)\b[,:]?\s*(?:must|should|need to|are required to|please)\b/i,
  /<\|?(?:im_start|im_end|endoftext)\|?>|\[\/?INST\]|<<\/?SYS>>/i,
]

/** True when the host validator reads `text` as an instruction to an agent. */
export const looksLikeInstruction = (text) =>
  INJECTION_PHRASES.some((pattern) => pattern.test(text.replace(/\s+/g, " ")))

/** A purpose keeps at most this many characters; a longer text ends at a sentence or with "…". */
export const MAX_PURPOSE_CHARS = 300
const MIN_PURPOSE_CHARS = 10

/**
 * A purpose that the knowledge file can hold, or null: one line, no
 * control, direction, or zero-width characters, no Markdown link, URL, or HTML,
 * at most MAX_PURPOSE_CHARS characters.
 */
export function cleanPurpose(raw) {
  if (typeof raw !== "string") return null
  let text = raw
    .replace(
      // oxlint-disable-next-line no-control-regex -- the purpose is one line of plain text
      /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
      " ",
    )
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/\[([^\]]+)\]/g, "$1")
    .replace(/<[^>]*>/g, "")
    // An external link goes only to a repository of the Workspace, so a
    // purpose holds no URL.
    .replace(EXTERNAL_URL, "")
    .replace(/[<>]/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (text.length > MAX_PURPOSE_CHARS) {
    const cut = text.slice(0, MAX_PURPOSE_CHARS)
    const end = cut.lastIndexOf(". ")
    text =
      end >= MIN_PURPOSE_CHARS
        ? cut.slice(0, end + 1)
        : `${cut.slice(0, -1).trimEnd()}…`
  }
  return text.length >= MIN_PURPOSE_CHARS && /\p{L}{3}/u.test(text)
    ? text
    : null
}

/** A TOML string value of `key` in the lines of a table, or null. */
function tomlString(lines, key) {
  const at = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l))
  if (at === -1) return null
  const value = lines[at].slice(lines[at].indexOf("=") + 1).trim()
  for (const quote of ['"""', "'''"]) {
    if (!value.startsWith(quote)) continue
    const rest = [value.slice(3), ...lines.slice(at + 1)].join("\n")
    const end = rest.indexOf(quote)
    return end === -1 ? null : rest.slice(0, end).replace(/\\\n\s*/g, "")
  }
  const basic = /^"((?:[^"\\]|\\.)*)"/.exec(value)
  if (basic) {
    try {
      return JSON.parse(`"${basic[1]}"`)
    } catch {
      return null
    }
  }
  return /^'([^']*)'/.exec(value)?.[1] ?? null
}

/** The first paragraph of the doc comment lines, without the marks. */
function paragraph(lines) {
  const out = []
  for (const line of lines) {
    if (!line.trim()) {
      if (out.length) break
      continue
    }
    out.push(line.trim())
  }
  return out.join(" ")
}

/**
 * The doc comment of a Go file: the `//` lines directly above its `package`
 * clause (`// Package x …`, or the comment of a command), or null.
 */
function goDoc(text) {
  const lines = text.split("\n")
  const at = lines.findIndex((l) => /^package \w+/.test(l))
  const doc = []
  for (let i = at - 1; i >= 0 && lines[i].startsWith("//"); i--)
    doc.unshift(lines[i].slice(2))
  return doc.length ? paragraph(doc) : null
}

/** The crate doc of a Rust crate root: its leading `//!` lines or its leading `/*!` block, or null. */
function rustDoc(text) {
  const doc = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith("//!")) doc.push(trimmed.slice(3))
    else if (!doc.length && trimmed.startsWith("/*!")) {
      const block = [trimmed.slice(3)]
      for (let j = i + 1; j < lines.length && !block.at(-1).includes("*/"); j++)
        block.push(lines[j])
      return paragraph(block.join("\n").split("*/")[0].split("\n"))
    } else if (doc.length) break
    else if (trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("#!["))
      break
  }
  return doc.length ? paragraph(doc) : null
}

/**
 * The first prose paragraph of a Markdown README, or null. A heading, a
 * list, a quote, a table, a code block, an HTML block (also over more than
 * one line), and a badge or image line are not prose.
 */
function readmeParagraph(text) {
  const out = []
  let fenced = false
  // The count of HTML tags that are open: a tag can go over more than one line.
  let open = 0
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line.startsWith("```") || line.startsWith("~~~")) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const tag = open > 0 || line.startsWith("<")
    if (tag)
      open = Math.max(
        0,
        open +
          (line.match(/</g) ?? []).length -
          (line.match(/>/g) ?? []).length,
      )
    const prose =
      line !== "" &&
      !tag &&
      /^[\p{L}\p{N}"'`(*_]/u.test(line) &&
      !/^(?:[-*+]|\d+[.)])\s/.test(line) &&
      !/^\.\. /.test(line) &&
      !/=\s*"/.test(line)
    if (!prose) {
      if (out.length) break
      continue
    }
    out.push(line)
  }
  return out.length ? out.join(" ") : null
}

/**
 * The purpose of the root at `rootPath`, as { text, evidence }, or null.
 * `files` is the set of tracked files of the source. A purpose that looks
 * like an instruction to an agent is not used: the next source gives the
 * purpose, and `refused` gets an entry for `skipped` (CTX-1536).
 */
export function purposeOf(source, files, rootPath, refused = []) {
  const dir = rootPath === "." ? "" : `${rootPath}/`
  const at = (path) => `${dir}${path}`
  const read = (path) => readTracked(source, at(path))
  const found = (raw, path) => {
    const text = cleanPurpose(raw)
    if (text && looksLikeInstruction(text)) {
      refused.push({
        path: at(path),
        reason:
          "The purpose in the file looks like an instruction to an agent, so the script did not use it",
      })
      return null
    }
    return text ? { text, evidence: at(path) } : null
  }
  const direct = [...files].filter(
    (f) => f.startsWith(dir) && !f.slice(dir.length).includes("/"),
  )

  const candidates = [
    () => {
      if (!files.has(at("package.json"))) return null
      try {
        return found(
          JSON.parse(read("package.json")).description,
          "package.json",
        )
      } catch {
        return null
      }
    },
    () =>
      files.has(at("Cargo.toml"))
        ? found(
            tomlString(
              tomlTables(read("Cargo.toml")).get("package") ?? [],
              "description",
            ),
            "Cargo.toml",
          )
        : null,
    () => {
      if (!files.has(at("pyproject.toml"))) return null
      const tables = tomlTables(read("pyproject.toml"))
      for (const table of ["project", "tool.poetry"]) {
        const purpose = found(
          tomlString(tables.get(table) ?? [], "description"),
          "pyproject.toml",
        )
        if (purpose) return purpose
      }
      return null
    },
    () => {
      const go = direct
        .filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))
        .sort(
          (a, b) =>
            Number(b.endsWith("/doc.go") || b === "doc.go") -
              Number(a.endsWith("/doc.go") || a === "doc.go") ||
            (a < b ? -1 : 1),
        )
      for (const file of go) {
        const purpose = found(
          goDoc(readTracked(source, file)),
          posix.basename(file),
        )
        if (purpose) return purpose
      }
      return null
    },
    () => {
      for (const file of ["src/lib.rs", "src/main.rs", "lib.rs", "main.rs"]) {
        if (!files.has(at(file))) continue
        const purpose = found(rustDoc(read(file)), file)
        if (purpose) return purpose
      }
      return null
    },
    () => {
      const readme = direct
        .filter((f) =>
          /^readme(\.(md|markdown|txt|rst))?$/i.test(f.slice(dir.length)),
        )
        .sort()[0]
      return readme
        ? found(
            readmeParagraph(readTracked(source, readme)),
            readme.slice(dir.length),
          )
        : null
    },
  ]
  for (const candidate of candidates) {
    const purpose = candidate()
    if (purpose) return purpose
  }
  return null
}
