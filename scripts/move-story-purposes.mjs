// One-time move (CTX-1375): each `parameters.review.purpose` of a story goes
// into the JSDoc comment of the story, when the story has no JSDoc of its
// own. `review.kind` stays. An empty `review` or `parameters` object goes
// away. A story that has both a JSDoc and a purpose stays as it is: the
// script lists it, and a person or an agent merges the two texts by hand.
//
// Usage: node scripts/move-story-purposes.mjs [--dry] [--list <file.json>]
//   --dry   changes no file
//   --list  writes the stories with both a JSDoc and a purpose to this file

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const dry = process.argv.includes("--dry")
const listIndex = process.argv.indexOf("--list")
const listFile = listIndex > 0 ? process.argv[listIndex + 1] : null

const storyFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : storyFiles(path)
    return /\.stories\.tsx?$/.test(entry.name) ? [path] : []
  })

const nameOf = (node) =>
  node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ? node.name.text
    : null

/** The property `name` of an object literal, or undefined. */
const propertyOf = (object, name) =>
  object.properties.find(
    (property) => ts.isPropertyAssignment(property) && nameOf(property) === name,
  )

/** Each `parameters: { review: { purpose } }` in the node, with its objects. */
function purposesIn(node, found = []) {
  if (ts.isObjectLiteralExpression(node)) {
    const parameters = propertyOf(node, "parameters")
    const review =
      parameters &&
      ts.isObjectLiteralExpression(parameters.initializer) &&
      propertyOf(parameters.initializer, "review")
    const purpose =
      review &&
      ts.isObjectLiteralExpression(review.initializer) &&
      propertyOf(review.initializer, "purpose")
    if (purpose) found.push({ parameters, review, purpose })
  }
  ts.forEachChild(node, (child) => {
    purposesIn(child, found)
  })
  return found
}

/** The range that removes a property, with its comma and its own lines. */
function removal(text, property) {
  let start = property.getFullStart()
  let end = property.getEnd()
  const comma = /^\s*,/.exec(text.slice(end))
  if (comma) end += comma[0].length
  return { start, end, insert: "" }
}

/** A JSDoc comment with the text, wrapped at 80 columns. */
function jsDoc(text) {
  if (text.length + 7 <= 80) return `/** ${text} */\n`
  const lines = []
  let line = ""
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > 77) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  lines.push(line)
  return `/**\n${lines.map((each) => ` * ${each}`).join("\n")}\n */\n`
}

const both = []
let moved = 0
for (const path of storyFiles(join(root, "apps/ui/src"))) {
  const file = relative(root, path)
  const text = readFileSync(path, "utf8")
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const edits = []
  for (const statement of source.statements) {
    const exported =
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    const found = purposesIn(statement)
    if (!found.length) continue
    if (!exported || found.length > 1)
      throw new Error(`${file}: a purpose outside one story export`)
    const name = statement.declarationList.declarations[0].name.text
    const { parameters, review, purpose } = found[0]
    const value = purpose.initializer
    if (!ts.isStringLiteralLike(value))
      throw new Error(`${file}: story "${name}" has a purpose that is not a string`)
    if (value.text.includes("*/"))
      throw new Error(`${file}: story "${name}" has "*/" in its purpose`)
    const comments = ts.getLeadingCommentRanges(text, statement.getFullStart())
    const doc = comments
      ?.filter((comment) => text.startsWith("/**", comment.pos))
      .at(-1)
    if (doc) {
      both.push({
        file,
        story: name,
        jsDoc: text.slice(doc.pos, doc.end),
        purpose: value.text,
      })
      continue
    }
    // The innermost object that stays non-empty loses the property.
    const reviewObject = review.initializer
    const parametersObject = parameters.initializer
    const target =
      reviewObject.properties.length > 1
        ? purpose
        : parametersObject.properties.length > 1
          ? review
          : parameters
    edits.push(removal(text, target))
    edits.push({
      start: statement.getStart(),
      end: statement.getStart(),
      insert: jsDoc(value.text),
    })
    moved += 1
  }
  if (!edits.length || dry) continue
  let next = text
  for (const edit of edits.sort((a, b) => b.start - a.start))
    next = next.slice(0, edit.start) + edit.insert + next.slice(edit.end)
  writeFileSync(path, next)
}

if (listFile) writeFileSync(listFile, `${JSON.stringify(both, null, 2)}\n`)
console.log(
  `${dry ? "Would move" : "Moved"} ${moved} purposes; ${both.length} stories have both a JSDoc and a purpose.`,
)
