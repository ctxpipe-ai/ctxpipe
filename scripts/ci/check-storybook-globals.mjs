// The globals of Storybook add no mock, add nothing to the DOM of a story
// and change no behavior that a story sees (the storybook skill, "No
// globals"). A story file declares its mocks and its wrappers itself: in its
// meta or in its stories.
//
// The check reads the files of apps/ui/.storybook and fails when:
//   - `preview.tsx` sets `parameters.msw` (a handler for every story);
//   - `setupWorker()` of the MSW worker gets an initial handler other than
//     `unhandledSocketHandler`. That handler answers no socket: it
//     closes a socket that no story handler matches, so that the story
//     fails (see preview.tsx);
//   - a file of .storybook imports the shared mocks (`src/mocks`), makes an
//     MSW handler (`http.*`, `graphql.*`) or adds one to the worker
//     (`worker.use(...)`, or `msw.use(...)` of the story context);
//   - a global decorator of `preview.tsx` is not
//     `optIn(["<parameter>", ...], decorator)`. `optIn` renders the story as
//     it is until the story file sets one of the parameters.
//
// The check reads the source by names: it does not follow an import out of
// .storybook or an aliased `http`. The story Testing/Preview globals
// (apps/ui/src/lib/preview-globals.stories.tsx) checks the result in the
// browser: no wrapper, no Query client and no handler but the socket
// enforcement for a story with no opt-in.
//
// Usage: node scripts/ci/check-storybook-globals.mjs [repo root]   (default: this repo)

import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

const root = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)),
)
const storybookDir = join(root, "apps/ui/.storybook")
const errors = []

const parse = (path) =>
  ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

const where = (source, node) =>
  `${relative(root, source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`

const visit = (node, callback) => {
  callback(node)
  ts.forEachChild(node, (child) => visit(child, callback))
}

const propertyName = (property) =>
  property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ? property.name.text
    : undefined

const files = readdirSync(storybookDir, { recursive: true })
  .map(String)
  .filter((name) => /\.(tsx?|mjs|js)$/.test(name) && !name.endsWith(".d.ts"))
  .map((name) => join(storybookDir, name))

for (const path of files) {
  const source = parse(path)
  visit(source, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /(^@\/|\/src\/)mocks(\/|$)/.test(node.moduleSpecifier.text)
    )
      errors.push(
        `${where(source, node)}: imports the shared mocks (${node.moduleSpecifier.text}). A story file composes its handlers from src/mocks in its meta or its stories.`,
      )
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    if (!ts.isPropertyAccessExpression(callee)) return
    if (
      ts.isIdentifier(callee.expression) &&
      ["http", "graphql"].includes(callee.expression.text)
    )
      errors.push(
        `${where(source, node)}: makes an MSW handler (${callee.expression.text}.${callee.name.text}). A handler belongs to a story file.`,
      )
    if (
      callee.name.text === "use" &&
      ts.isIdentifier(callee.expression) &&
      ["worker", "msw"].includes(callee.expression.text)
    )
      errors.push(
        `${where(source, node)}: adds a handler to the worker (.use). A story file adds its handlers in the beforeEach of its meta or its stories.`,
      )
  })
}

const previewPath = join(storybookDir, "preview.tsx")
const preview = parse(previewPath)
let previewObject
visit(preview, (node) => {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "definePreview" &&
    node.arguments[0] &&
    ts.isObjectLiteralExpression(node.arguments[0])
  )
    previewObject = node.arguments[0]
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "setupWorker"
  ) {
    const allowed = node.arguments.every(
      (handler) =>
        ts.isIdentifier(handler) && handler.text === "unhandledSocketHandler",
    )
    if (!allowed)
      errors.push(
        `${where(preview, node)}: setupWorker() gets initial handlers. Only unhandledSocketHandler (it answers no socket) may be there; a story file adds its handlers in the beforeEach of its meta or its stories.`,
      )
  }
})

if (!previewObject)
  errors.push(
    `${relative(root, previewPath)}: found no \`definePreview({ ... })\` object to check.`,
  )
else
  for (const property of previewObject.properties) {
    const name = propertyName(property)
    if (name === "parameters") {
      if (
        !ts.isPropertyAssignment(property) ||
        !ts.isObjectLiteralExpression(property.initializer)
      ) {
        errors.push(
          `${where(preview, property)}: parameters must be an object literal, so that the check can read it.`,
        )
        continue
      }
      for (const parameter of property.initializer.properties)
        if (propertyName(parameter) === "msw" || ts.isSpreadAssignment(parameter))
          errors.push(
            `${where(preview, parameter)}: preview parameters set MSW handlers for every story. Put the handlers in the story file (its meta or its stories).`,
          )
    }
    if (name === "decorators") {
      if (
        !ts.isPropertyAssignment(property) ||
        !ts.isArrayLiteralExpression(property.initializer)
      ) {
        errors.push(
          `${where(preview, property)}: decorators must be an array literal, so that the check can read it.`,
        )
        continue
      }
      for (const decorator of property.initializer.elements) {
        const optIn =
          ts.isCallExpression(decorator) &&
          ts.isIdentifier(decorator.expression) &&
          decorator.expression.text === "optIn" &&
          decorator.arguments.length === 2 &&
          ts.isArrayLiteralExpression(decorator.arguments[0]) &&
          decorator.arguments[0].elements.length > 0 &&
          decorator.arguments[0].elements.every(ts.isStringLiteral)
        if (!optIn)
          errors.push(
            `${where(preview, decorator)}: a global decorator must be optIn(["<parameter>", ...], decorator), a no-op until the story file sets a parameter.`,
          )
      }
    }
  }

for (const error of errors) console.error(error)
if (errors.length) process.exit(1)
console.log(
  `Storybook globals check passed (${files.length} files of apps/ui/.storybook).`,
)
