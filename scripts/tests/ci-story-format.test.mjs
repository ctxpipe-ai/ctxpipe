import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(
  new URL("../ci/check-story-format.mjs", import.meta.url),
)

/** Runs the check on a fixture repo with these story files under apps/ui/src. */
function check(stories) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-story-format-"))
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

const csf4 = (story = "{}") => `
import preview from "../../.storybook/preview"
const meta = preview.meta({ title: "Example" })
export const Empty = meta.story(${story})
`
const csf3 = `
const meta = { title: "Example", parameters: { msw: { handlers: [] } } }
export default meta
export const Empty = {}
`

test("CSF 4 files pass", () => {
  const result = check({
    "Card.stories.tsx": csf4(
      "{ beforeEach: ({ msw }) => { msw.use(sessionHandler) } }",
    ),
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Story format check passed \(1 story files\)/)
})

test("a CSF 3 file fails", () => {
  const result = check({ "Old.stories.tsx": csf3 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Old\.stories\.tsx is CSF 3\. Write it in CSF 4/)
})

test("a CSF 4 file that sets parameters.msw fails", () => {
  const result = check({
    "Card.stories.tsx": csf4(
      "{ parameters: { msw: { handlers: [sessionHandler] } } }",
    ),
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Card\.stories\.tsx sets `msw:`/)
})

test("a CSF 4 file that sets the shorthand parameters: { msw } fails", () => {
  const result = check({
    "Card.stories.tsx": `const msw = { handlers: [] }\n${csf4("{ parameters: { msw } }")}`,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Card\.stories\.tsx sets `msw:`/)
})
