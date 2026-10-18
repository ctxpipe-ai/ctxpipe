#!/usr/bin/env node
// Guards Storybook plays against two race patterns (see the storybook skill, "Play timing"):
//   1. `expect(await …findBy…)` outside a `waitFor` callback.
//   2. A variable that holds an element from `findBy…` / `getBy…`, then is used in
//      `expect(x)` or `userEvent.*(x)` after a later `await`, outside a `waitFor` callback.
//   3. An absence check (`expect(…queryBy…/querySelector…).not.toBeInTheDocument()`, `.toBeNull()`,
//      or `queryAllBy…` with `toHaveLength(0)`) with no earlier settled wait in the same play.
//      A settled wait is `findBy…`, `getBy…` (it throws when the element is missing), an awaited helper named `expect…`, `wait…` or `find…` (for example `expectWorkspaceFiles`), or a `waitFor` whose callback holds no absence check.
//   4. A layout measure (`scrollWidth`, `clientWidth`, `getBoundingClientRect`) in a story with no earlier
//      `await document.fonts.ready`. A font that loads later moves the text, so the size or position changes.
// A line that ends with `// play-timing: ok <reason>`, or the line before one, is exempt.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : execFileSync("git", ["ls-files", "*.stories.tsx", "*.stories.ts"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)

const problems = []
const stateMatcher =
  "(?:not\\.)?(?:toBeVisible|toBeChecked|toBeEnabled|toBeDisabled|toHaveStyle|toHaveValue|toHaveTextContent|toHaveAttribute|toHaveClass|toHaveFocus)"

function matchParen(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++
    else if (text[i] === ")" && --depth === 0) return i
  }
  return -1
}

for (const file of files) {
  const text = readFileSync(file, "utf8")
  const lines = text.split("\n")
  // Offsets of waitFor( … ) callback spans, found by paren matching.
  const spans = []
  for (const m of text.matchAll(/\bwaitFor\s*\(/g)) {
    let depth = 0
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      if (text[i] === "(") depth++
      else if (text[i] === ")" && --depth === 0) {
        spans.push([m.index, i])
        break
      }
    }
  }
  const inWaitFor = (offset) => spans.some(([a, b]) => offset > a && offset < b)
  const lineOf = (offset) => text.slice(0, offset).split("\n").length
  // The formatter can move the marker from the end of `expect(` to the next line.
  const exempt = (line) =>
    /play-timing: ok/.test(`${lines[line - 1] ?? ""}\n${lines[line] ?? ""}`)

  for (const m of text.matchAll(
    /expect\(\s*await\s+[\w.]*\.find(?:All)?By\w*\(/g,
  )) {
    const end = matchParen(text, m.index + m[0].length - 1)
    if (
      end < 0 ||
      !new RegExp(`^\\s*,?\\s*\\)\\s*\\.${stateMatcher}\\b`).test(
        text.slice(end + 1),
      )
    )
      continue
    const line = lineOf(m.index)
    if (!inWaitFor(m.index) && !exempt(line))
      problems.push(
        `${file}:${line}: expect(await findBy…).<state matcher> outside waitFor. Use await waitFor(() => expect(getBy…).<matcher>).`,
      )
  }

  const decl =
    /^[ \t]*(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?[\w.]+\.(?:find|get)(?:All)?By\w*\(/gm
  for (const m of text.matchAll(decl)) {
    const name = m[1]
    const declEnd = m.index + m[0].length
    // End of the enclosing story: the next top-level `export const`.
    const next = text.indexOf("\nexport const", declEnd)
    const scopeEnd = next === -1 ? text.length : next
    const use = new RegExp(
      `expect\\(\\s*${name}\\s*\\)\\s*\\.${stateMatcher}\\b`,
      "g",
    )
    use.lastIndex = declEnd
    for (let u = use.exec(text); u && u.index < scopeEnd; u = use.exec(text)) {
      const between = text.slice(declEnd, u.index)
      const line = lineOf(u.index)
      if (
        /\bawait\s+userEvent\b/.test(between) &&
        !inWaitFor(u.index) &&
        !exempt(line)
      )
        problems.push(
          `${file}:${line}: "${name}" holds an element from line ${lineOf(m.index)} and is used after an interaction. Query it again inside waitFor.`,
        )
    }
  }

  // Absence checks. The scope of a play runs from the last top-level declaration before the check.
  const absenceArg = /\.(?:queryAllBy|queryBy)\w*\(|\bquerySelector(?:All)?\(/
  const absenceMatcher =
    /^\s*\.(?:not\.toBeInTheDocument\(\)|toBeNull\(\)|toHaveLength\(0\))/
  const absenceAt = (offset) => {
    const m = /expect\(/y
    m.lastIndex = offset
    if (!m.test(text)) return false
    const end = matchParen(text, offset + 6)
    return (
      end > 0 &&
      absenceArg.test(text.slice(offset, end)) &&
      absenceMatcher.test(text.slice(end + 1))
    )
  }
  const checks = [...text.matchAll(/expect\(/g)]
    .map((m) => m.index)
    .filter(absenceAt)
  for (const at of checks) {
    const line = lineOf(at)
    if (exempt(line)) continue
    let scopeStart = 0
    for (const d of text
      .slice(0, at)
      .matchAll(/\n(?:export\s+)?(?:async\s+)?(?:const|let|function)\s/g))
      scopeStart = d.index
    const before = text.slice(scopeStart, at)
    // An interaction can start new requests, so a wait counts only after the last one.
    let from = 0
    for (const i of before.matchAll(/\buserEvent\.\w+\(|\bfireEvent\.\w+\(/g))
      from = i.index
    // A check inside waitFor retries, so it may follow an interaction (a dialog that closes).
    if (inWaitFor(at)) from = 0
    const hasFind =
      /\.(?:find|get)(?:All)?By\w*\(|\bawait\s+(?:expect|wait|find)[A-Z]\w*\(/.test(
        before.slice(from),
      )
    const hasWait = spans.some(([a, b]) => {
      if (a < scopeStart + from || b > at) return false
      return !checks.some((c) => c > a && c < b)
    })
    if (!hasFind && !hasWait)
      problems.push(
        `${file}:${line}: absence check with no earlier settled wait in this play. First wait for a positive sign (findBy… or waitFor on a loaded element or an answered request), then assert absence.`,
      )
  }

  // Layout measures. A story is a top-level `export const` object; a helper outside it is not checked.
  for (const story of text.matchAll(/\nexport const \w+[^=\n]*=/g)) {
    const end = text.indexOf("\n}\n", story.index)
    const body = text.slice(story.index, end === -1 ? text.length : end)
    const measure =
      /\b(?:scrollWidth|clientWidth)\b|\bgetBoundingClientRect\(/.exec(body)
    if (!measure) continue
    const at = story.index + measure.index
    const line = lineOf(at)
    if (exempt(line)) continue
    const fonts = body.indexOf("document.fonts.ready")
    if (fonts === -1 || fonts > measure.index)
      problems.push(
        `${file}:${line}: layout measure before \`await document.fonts.ready\`. A font that loads later moves the text. Wait for fonts first.`,
      )
  }
}

if (problems.length) {
  console.error(problems.join("\n"))
  console.error(
    `\n${problems.length} play timing problem(s). See .agents/skills/storybook/SKILL.md "Play timing".`,
  )
  process.exit(1)
}
console.log(`Story play timing: ${files.length} files OK`)
