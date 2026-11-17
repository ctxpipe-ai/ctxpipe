import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(
  new URL("../ci/check-story-review.mjs", import.meta.url),
)

/** Runs the check on a fixture repo with these story files under apps/ui/src. */
function check(stories) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-story-review-"))
  try {
    for (const [name, text] of Object.entries(stories)) {
      const file = join(root, "apps/ui/src", name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
    }
    return spawnSync(process.execPath, [script, root], { encoding: "utf8" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const storyFile = (meta, stories) => `
const meta = { title: "Example", parameters: ${meta} }
export default meta
${stories}
`

test("stories with a kind (own or of the meta) and their own JSDoc purpose pass", () => {
  const result = check({
    "Card.stories.tsx": storyFile(
      `{ review: { kind: "component" } }`,
      `/** Workspace card that a member opens to read its sources, before anyone added a source. */
export const Empty = {}
/** Org home page of a member with two Workspaces, right after sign-in. */
export const Page = { parameters: { review: { kind: "page" } } }`,
    ),
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Story review check passed \(2 stories\)/)
})

test("a story with no kind, or with no purpose of its own, fails", () => {
  const result = check({
    "Card.stories.tsx": storyFile(
      "{}",
      `/** Workspace card that a member opens to read its sources, before anyone added a source. */
export const Empty = {}
export const Loading = { parameters: { review: { kind: "component" } } }`,
    ),
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /story "Empty" has no parameters\.review\.kind/)
  assert.match(result.stderr, /story "Loading" has no purpose/)
  assert.doesNotMatch(result.stderr, /"Empty" has no purpose/)
})

test("a kind that is not page or component, and a purpose that is not a description for the critic, fail", () => {
  const result = check({
    "Card.stories.tsx": storyFile(
      "{}",
      `/** Delete dialog of a Workspace, where an admin confirms the delete, open. */
export const Dialog = { parameters: { review: { kind: "dialog" } } }
/** Shows the card of a Workspace, with its sources and its members. */
export const Vague = { parameters: { review: { kind: "component" } } }
/** Workspace card ${"a".repeat(500)} */
export const Long = { parameters: { review: { kind: "component" } } }`,
    ),
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /story "Dialog" has no parameters\.review\.kind/)
  assert.match(result.stderr, /story "Vague": the purpose must/)
  assert.match(result.stderr, /story "Long": the purpose must/)
})

test("a purpose is one sentence or a short paragraph of a sane length about the UI", () => {
  const text = "Workspace card that a member opens to read its sources"
  const result = check({
    "Card.stories.tsx": storyFile(
      `{ review: { kind: "component" } }`,
      `/** Empty Workspace card. */
export const Short = {}
/** Displays the ${text}, with no sources yet. */
export const Displays = {}
/** Renders the ${text}, with no sources yet. */
export const Renders = {}
/** After the member deletes the last source, the ${text} says that it has none. */
export const NoColon = {}
/**
 * ${text}: the member deleted the last source. The play proves that the
 * card reads the sources one time (CTX-1).
 */
export const Paragraph = {}
/** ${text}: ${"a".repeat(500 - text.length - 2)} */
export const Longest = {}`,
    ),
  })
  assert.equal(result.status, 1)
  for (const name of ["Short", "Displays", "Renders"])
    assert.match(result.stderr, new RegExp(`story "${name}": the purpose must`))
  assert.doesNotMatch(result.stderr, /"NoColon"|"Paragraph"|"Longest"/)
})

test("the line breaks of the JSDoc count as spaces, and a line comment is not a purpose", () => {
  const result = check({
    "Card.stories.tsx": storyFile(
      `{ review: { kind: "component" } }`,
      `/**
 * Workspace card that a member opens to read its sources, before anyone
 * added a source.
 */
export const Empty = {}
// A line comment is not a JSDoc description.
export const LineComment = {}`,
    ),
  })
  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stderr, /"Empty"/)
  assert.match(result.stderr, /story "LineComment" has no purpose/)
})

test("a JSDoc of the meta is not the purpose of a story", () => {
  const result = check({
    "Card.stories.tsx": `
/** Workspace card that a member opens to read its sources, before anyone added a source. */
const meta = { title: "Example", parameters: { review: { kind: "component" } } }
export default meta
export const Empty = {}`,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /story "Empty" has no purpose/)
})

test("parameters.review has only kind: an old review.purpose fails, in the story or in the meta", () => {
  const result = check({
    "Card.stories.tsx": storyFile(
      `{ review: { kind: "component", purpose: "A purpose of the meta." } }`,
      `/** Workspace card that a member opens to read its sources, before anyone added a source. */
export const Empty = { parameters: { review: { purpose: "Workspace card that a member opens to read its sources." } } }`,
    ),
  })
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /story "Empty": parameters\.review has "purpose", "purpose"\. It has only "kind"/,
  )
  assert.doesNotMatch(result.stderr, /has no purpose/)
})
