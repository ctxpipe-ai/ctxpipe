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
      `export const Empty = { parameters: { review: { purpose: "Workspace card with no sources yet." } } }
export const Page = { parameters: { review: { kind: "page", purpose: "Org home page of a member with two Workspaces." } } }`,
    ),
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Story review check passed \(2 stories\)/)
})

test("a story with no kind, or with no purpose of its own, fails", () => {
  const result = check({
    "Card.stories.tsx": storyFile(
      `{ review: { purpose: "A purpose of the meta does not count." } }`,
      `export const Empty = { parameters: { review: { purpose: "Workspace card with no sources yet." } } }
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
export const Long = { parameters: { review: { kind: "component", purpose: "${"A".repeat(201)}" } } }
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
