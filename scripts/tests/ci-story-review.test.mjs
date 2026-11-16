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

test("stories with a kind (own or of the meta) and their own purpose pass", () => {
  const result = check({
    "Card.stories.tsx": storyFile(
      `{ review: { kind: "component" } }`,
      `export const Empty = { parameters: { review: { purpose: "Workspace card that a member opens to read its sources, before anyone added a source." } } }
export const Page = { parameters: { review: { kind: "page", purpose: "Org home page of a member with two Workspaces, right after sign-in." } } }`,
    ),
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Story review check passed \(2 stories\)/)
})

test("a story with no kind, or with no purpose of its own, fails", () => {
  const result = check({
    "Card.stories.tsx": storyFile(
      `{ review: { purpose: "A purpose of the meta does not count." } }`,
      `export const Empty = { parameters: { review: { purpose: "Workspace card that a member opens to read its sources, before anyone added a source." } } }
export const Loading = { parameters: { review: { kind: "component" } } }`,
    ),
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /story "Empty" has no parameters\.review\.kind/)
  assert.match(
    result.stderr,
    /story "Loading" has no parameters\.review\.purpose/,
  )
  assert.doesNotMatch(result.stderr, /"Empty" has no parameters\.review\.purpose/)
})

test("a kind that is not page or component, and a purpose that is not a sentence for the critic, fail", () => {
  const result = check({
    "Card.stories.tsx": storyFile(
      "{}",
      `export const Dialog = { parameters: { review: { kind: "dialog", purpose: "Delete dialog of a Workspace, open." } } }
export const Vague = { parameters: { review: { kind: "component", purpose: "Shows the card." } } }
export const Long = { parameters: { review: { kind: "component", purpose: "Workspace card ${"a".repeat(240)}" } } }
const text = "Workspace card."
export const NotLiteral = { parameters: { review: { kind: "component", purpose: text } } }`,
    ),
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /story "Dialog" has no parameters\.review\.kind/)
  assert.match(result.stderr, /story "Vague": parameters\.review\.purpose must/)
  assert.match(result.stderr, /story "Long": parameters\.review\.purpose must/)
  assert.match(
    result.stderr,
    /story "NotLiteral" has no parameters\.review\.purpose/,
  )
})

test("a purpose is a sentence of a sane length about the UI, in any form", () => {
  const text = "Workspace card that a member opens to read its sources"
  const result = check({
    "Card.stories.tsx": storyFile(
      `{ review: { kind: "component" } }`,
      `export const Short = { parameters: { review: { purpose: "Empty Workspace card." } } }
export const Displays = { parameters: { review: { purpose: "Displays the ${text}, with no sources yet." } } }
export const Renders = { parameters: { review: { purpose: "Renders the ${text}, with no sources yet." } } }
export const NoColon = { parameters: { review: { purpose: "After the member deletes the last source, the ${text} says that it has none." } } }
export const Longest = { parameters: { review: { purpose: "${text}: ${"a".repeat(240 - text.length - 2)}" } } }`,
    ),
  })
  assert.equal(result.status, 1)
  for (const name of ["Short", "Displays", "Renders"])
    assert.match(
      result.stderr,
      new RegExp(`story "${name}": parameters\\.review\\.purpose must`),
    )
  assert.doesNotMatch(result.stderr, /"NoColon"|"Longest"/)
})
