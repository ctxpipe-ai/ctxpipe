// Rejects a new single-use value at module scope (AGENTS.md "Code style":
// "Avoid pulling to globals").
//
// A non-exported top-level `const` that holds a plain value (a string, a
// number, or a template with no substitution)
// and that the file reads in only one place belongs at that place. The check
// reads the lines that the change adds, in the files of the apps, packages,
// and scripts that are not tests, stories, or generated. A value that must
// stay at module scope (for example, a hot-path table) carries
// `scope-allow: <reason>` on its line or the line before it.
//
// Usage: node scripts/ci/check-module-scope-values.mjs [repository root] [base ref]
//   (default base: origin/main)

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

import { addedLines, changedFiles } from "./changed-files.mjs"

const checked = /^(apps|packages|scripts)\/.*\.(ts|tsx|mjs|js)$/
const skipped =
  /(\.test\.|\.spec\.|\.stories\.|\.d\.ts$|\.generated\.|\/(test|tests|evals|node_modules|migrations)\/)/

function isPlainValue(node) {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return isPlainValue(node.expression)
  if (ts.isParenthesizedExpression(node)) return isPlainValue(node.expression)
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node)
  )
    return true
  return false
}

/** Single-use plain values at module scope: `{ name, line }`. */
export function singleUseValues(fileName, text) {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const candidates = []
  for (const statement of source.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue
    for (const declaration of statement.declarationList.declarations)
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        isPlainValue(declaration.initializer)
      )
        candidates.push(declaration)
  }
  const uses = new Map(candidates.map((c) => [c.name.text, 0]))
  const visit = (node) => {
    if (ts.isIdentifier(node) && uses.has(node.text)) {
      const parent = node.parent
      const isDeclaration = candidates.some((c) => c.name === node)
      const isKey =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node)
      if (!isDeclaration && !isKey) uses.set(node.text, uses.get(node.text) + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const lines = text.split("\n")
  return candidates
    .filter((c) => uses.get(c.name.text) === 1)
    .map((c) => ({
      name: c.name.text,
      line: source.getLineAndCharacterOfPosition(c.getStart(source)).line + 1,
    }))
    .filter(
      ({ line }) =>
        !/scope-allow:/.test(`${lines[line - 2]}\n${lines[line - 1]}`),
    )
}

function main() {
  const root = resolve(process.argv[2] ?? ".")
  const base = process.argv[3] ?? "origin/main"
  let failed = false
  for (const { status, path } of changedFiles(root, base)) {
    if (status === "D" || !checked.test(path) || skipped.test(path)) continue
    const added = addedLines(root, base, path)
    for (const { name, line } of singleUseValues(
      path,
      readFileSync(join(root, path), "utf8"),
    ))
      if (added.has(line)) {
        failed = true
        console.error(
          `${path}:${line}: \`${name}\` is a module-scope value that the file reads once. Inline it where it is used, or write \`scope-allow: <reason>\` above it.`,
        )
      }
  }
  if (failed) process.exit(1)
  console.log("Module-scope value check passed.")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
