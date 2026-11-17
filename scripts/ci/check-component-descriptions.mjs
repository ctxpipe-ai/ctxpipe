// Each exported React component of apps/ui has a description (the Storybook
// skill, "Component docs").
//
// The description is the JSDoc comment above the component: what it is for,
// and when to use it instead of a similar component. Storybook shows it in
// `storybook tools docs`, and agents read it there to find the shared
// component with the same meaning.
//
// A component is an exported PascalCase function in a `.tsx` file under
// apps/ui/src (not a story or a test): a function declaration, a `const` with
// an arrow or function expression, or a `const` with a call that wraps one
// (`forwardRef(...)`, `memo(...)`). The JSDoc must have text before its tags.
//
// The components that had no description before the check are in
// component-descriptions-allowlist.json. The check fails for a component that
// has no description and is not on the list. It also fails for a listed
// component that now has a description or is gone, so the list only shrinks.
//
// Usage: node scripts/ci/check-component-descriptions.mjs [repository root]

import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

const PASCAL = /^[A-Z][A-Za-z0-9]*$/

function isFunction(node) {
  return (
    node &&
    (ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      (ts.isCallExpression(node) && node.arguments.some(isFunction)))
  )
}

function description(node) {
  return ts
    .getJSDocCommentsAndTags(node)
    .filter(ts.isJSDoc)
    .map((doc) => ts.getTextOfJSDocComment(doc.comment) ?? "")
    .join(" ")
    .trim()
}

/** The exported components of one file: `{ name, line, described }`. */
function components(fileName, text) {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const exported = (node) =>
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  // Each local component, and whether the file exports it where it declares it.
  const local = new Map()
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body)
      local.set(statement.name.text, {
        node: statement,
        exported: exported(statement),
      })
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (
          ts.isIdentifier(declaration.name) &&
          isFunction(declaration.initializer)
        )
          local.set(declaration.name.text, {
            node: declaration,
            exported: exported(statement),
          })
  }
  // `export { Name }` and `export default Name` publish a local component.
  for (const statement of source.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements) {
        const entry = local.get((element.propertyName ?? element.name).text)
        if (entry) entry.exported = true
      }
    if (
      ts.isExportAssignment(statement) &&
      ts.isIdentifier(statement.expression)
    ) {
      const entry = local.get(statement.expression.text)
      if (entry) entry.exported = true
    }
  }
  return [...local]
    .filter(([name, entry]) => entry.exported && PASCAL.test(name))
    .map(([name, { node }]) => ({
      name,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      described: description(node) !== "",
    }))
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : sourceFiles(path)
    return /\.tsx$/.test(entry.name) &&
      !/\.(stories|test|spec)\.tsx$/.test(entry.name)
      ? [path]
      : []
  })
}

const root = resolve(
    process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)),
  )
  const listPath = "scripts/ci/component-descriptions-allowlist.json"
  const allowed = JSON.parse(readFileSync(join(root, listPath), "utf8"))
  const errors = []
  const missing = new Set()
  let count = 0
  for (const path of sourceFiles(join(root, "apps/ui/src"))) {
    const file = relative(root, path)
    const listed = new Set(allowed[file] ?? [])
    for (const { name, line, described } of components(
      file,
      readFileSync(path, "utf8"),
    )) {
      count += 1
      if (described) continue
      missing.add(`${file}\0${name}`)
      if (!listed.has(name))
        errors.push(
          `${file}:${line}: the component \`${name}\` has no description. Write a JSDoc comment (/** ... */) above it: what it is for, and when to use it instead of a similar component.`,
        )
    }
  }
  for (const [file, names] of Object.entries(allowed))
    for (const name of names)
      if (!missing.has(`${file}\0${name}`))
        errors.push(
          `${listPath}: ${file} no longer has the component \`${name}\` without a description. Remove it from the list.`,
        )
  for (const error of errors) console.error(error)
  if (errors.length) process.exit(1)
console.log(`Component description check passed (${count} components).`)
