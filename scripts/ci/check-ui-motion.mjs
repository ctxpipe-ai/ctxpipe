// Rejects slow UI motion (apps/ui/DESIGN.md "Motion").
//
// A transition or animation duration or delay above 150 ms fails, and so does
// `transition-all`. The check reads Tailwind classes (`duration-*`, `delay-*`,
// `duration-[…]`, `[transition:…]`, `animate-[…]`), inline `style` objects, and
// CSS declarations (also `@apply` and the Tailwind theme defaults).
//
// A loading indicator can loop for longer. It is exempt only when it carries a
// loader class: in TS/TSX, the line names the class; in CSS, the rule selector
// names it. For another real exception, write `motion-allow: <reason>` on the
// line or the line before it (TS/TSX), or inside the rule (CSS).
//
// Usage: node scripts/ci/check-ui-motion.mjs [directory]   (default apps/ui/src)

import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const MAX_MS = 150
const LOADER_CLASSES = [
  "animate-spin",
  "animate-pulse",
  "ctx-loading-motion",
  "ctx-indexing-dot",
  "ctx-unindexing",
  "ctx-unindexing-dot",
  "ctx-status-pulse",
  "inline-loader-indeterminate",
]
const LOADER = new RegExp(`(^|[^\\w-])(${LOADER_CLASSES.join("|")})(?![\\w-])`)
const MOTION_PROPERTY =
  /^(--default-)?(transition|animation)(-duration|-delay)?$/

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : sourceFiles(path)
    return /\.(css|ts|tsx)$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : []
  })
}

/** Each time value (`400ms`, `1.5s`) above the limit. */
function slowTimes(text) {
  const slow = []
  for (const match of text.matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)(?![\w-])/g)) {
    const ms = Number(match[1]) * (match[2] === "s" ? 1000 : 1)
    if (ms > MAX_MS) slow.push(match[0])
  }
  return slow
}

/** Problems in Tailwind class text and inline style objects. */
function classProblems(text) {
  const problems = []
  if (/(^|[\s"'`:])transition-all(?![\w-])/.test(text))
    problems.push("transition-all: name the exact properties")
  for (const match of text.matchAll(
    /(?<![\w-])(duration|delay)-(\d+)(?![\w-])/g,
  )) {
    if (Number(match[2]) > MAX_MS)
      problems.push(`${match[0]} is above ${MAX_MS} ms`)
  }
  const arbitrary = [
    /(?<![\w-])(?:duration|delay)-\[([^\]]+)\]/g,
    /\[(?:transition|animation)(?:-duration|-delay)?:([^\]]+)\]/g,
    /(?<![\w-])animate-\[([^\]]+)\]/g,
    /\b(?:transition|animation)(?:Duration|Delay)?\s*:\s*(["'`])(.*?)\1/g,
  ]
  for (const pattern of arbitrary) {
    for (const match of text.matchAll(pattern)) {
      for (const time of slowTimes(match.at(-1).replaceAll("_", " ")))
        problems.push(`${time} in ${match[0]} is above ${MAX_MS} ms`)
    }
  }
  return problems
}

function lineAt(text, offset) {
  return text.slice(0, offset).split("\n").length
}

function scriptFindings(text) {
  const lines = text.split("\n")
  return lines.flatMap((line, index) => {
    if (LOADER.test(line)) return []
    if (line.includes("motion-allow:")) return []
    if (index > 0 && lines[index - 1].includes("motion-allow:")) return []
    return classProblems(line).map((problem) => [index + 1, problem])
  })
}

/** Blanks each comment (line breaks stay), but keeps a motion-allow marker. */
function blankComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => {
    const blank = comment.replace(/[^\n]/g, " ")
    return comment.includes("motion-allow:")
      ? `motion-allow:${blank.slice(13)}`
      : blank
  })
}

function cssFindings(source) {
  const findings = []
  const text = blankComments(source)
  for (const rule of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const [, selector, body] = rule
    if (LOADER.test(selector) || body.includes("motion-allow:")) continue
    const bodyStart = rule.index + selector.length + 1
    let offset = 0
    for (const declaration of body.split(";")) {
      const colon = declaration.indexOf(":")
      const property = declaration.slice(0, colon).trim()
      const value = declaration.slice(colon + 1)
      const start = bodyStart + offset + declaration.search(/\S|$/)
      offset += declaration.length + 1
      if (colon < 0) {
        if (declaration.trim().startsWith("@apply"))
          for (const problem of classProblems(declaration))
            findings.push([lineAt(text, start), problem])
        continue
      }
      if (MOTION_PROPERTY.test(property))
        for (const time of slowTimes(value))
          findings.push([
            lineAt(text, start),
            `${time} in ${property} is above ${MAX_MS} ms`,
          ])
    }
  }
  return findings
}

try {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)))
  const directory = resolve(process.argv[2] ?? join(root, "apps/ui/src"))
  const files = sourceFiles(directory)
  const findings = files.flatMap((file) => {
    const text = readFileSync(file, "utf8")
    const found = file.endsWith(".css")
      ? cssFindings(text)
      : scriptFindings(text)
    return found.map(
      ([line, problem]) =>
        `${relative(process.cwd(), file)}:${line}: ${problem}`,
    )
  })
  if (findings.length)
    throw new Error(
      `${findings.join("\n")}\n${findings.length} slow motion finding(s); see apps/ui/DESIGN.md "Motion"`,
    )
  process.stdout.write(`UI motion checked ${files.length} files\n`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
