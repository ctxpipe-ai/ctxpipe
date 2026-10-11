// Rejects slow UI motion (apps/ui/DESIGN.md "Motion").
//
// A Tailwind `duration-N` class or a CSS `transition` / `animation` duration
// above 150 ms fails, and so does `transition-all`. A loading indicator loops,
// so a line that contains "infinite" passes. For another real exception, put
// `motion-allow: <reason>` on the line or on the line before it.
//
// Usage: node scripts/ci/check-ui-motion.mjs [directory]   (default apps/ui/src)

import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const MAX_MS = 150

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sourceFiles(path)
    }
    return /\.(css|ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : []
  })
}

function toMs(value, unit) {
  return unit === "s" ? Number(value) * 1000 : Number(value)
}

function lineProblems(line, isCss) {
  const problems = []
  if (/(^|[\s"'`:])transition-all(?![\w-])/.test(line)) {
    problems.push("transition-all: name the exact properties")
  }
  for (const match of line.matchAll(/(?<![\w-])duration-(\d+)(?![\w-])/g)) {
    if (Number(match[1]) > MAX_MS) {
      problems.push(`duration-${match[1]} is above ${MAX_MS} ms`)
    }
  }
  if (isCss && /^\s*(transition|animation)(-duration)?\s*:/.test(line)) {
    for (const match of line.matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)(?![\w-])/g)) {
      const ms = toMs(match[1], match[2])
      if (ms > MAX_MS) {
        problems.push(`${match[0]} is above ${MAX_MS} ms`)
      }
    }
  }
  return problems
}

export function findSlowMotion(directory) {
  const findings = []
  for (const file of sourceFiles(directory)) {
    const lines = readFileSync(file, "utf8").split("\n")
    const isCss = file.endsWith(".css")
    lines.forEach((line, index) => {
      if (line.includes("infinite")) return
      if (line.includes("motion-allow:")) return
      if (index > 0 && lines[index - 1].includes("motion-allow:")) return
      for (const problem of lineProblems(line, isCss)) {
        findings.push(`${relative(process.cwd(), file)}:${index + 1}: ${problem}`)
      }
    })
  }
  return findings
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)))
  const directory = resolve(process.argv[2] ?? join(root, "apps/ui/src"))
  const findings = findSlowMotion(directory)
  if (findings.length > 0) {
    console.error(
      `Slow UI motion (see apps/ui/DESIGN.md "Motion"):\n${findings.join("\n")}`,
    )
    process.exit(1)
  }
}
