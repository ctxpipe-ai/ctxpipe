#!/usr/bin/env node
// Guards Storybook plays against two race patterns (see the storybook skill, "Play timing"):
//   1. `expect(await …findBy…)` outside a `waitFor` callback.
//   2. A variable that holds an element from `findBy…` / `getBy…`, then is used in
//      `expect(x)` or `userEvent.*(x)` after a later `await`, outside a `waitFor` callback.
// A line that ends with `// play-timing: ok <reason>` is exempt.
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
  const exempt = (line) => /play-timing: ok/.test(lines[line - 1] ?? "")

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
}

if (problems.length) {
  console.error(problems.join("\n"))
  console.error(
    `\n${problems.length} play timing problem(s). See .agents/skills/storybook/SKILL.md "Play timing".`,
  )
  process.exit(1)
}
console.log(`Story play timing: ${files.length} files OK`)
