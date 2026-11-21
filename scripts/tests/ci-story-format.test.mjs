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

/**
 * Runs the check on a fixture repo with these story files under apps/ui/src
 * and this list of the CSF 3 files that are not converted yet.
 */
function check(stories, listed = []) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-story-format-"))
  try {
    for (const [name, text] of Object.entries(stories)) {
      const file = join(root, "apps/ui/src", name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
    }
    mkdirSync(join(root, "scripts/ci"), { recursive: true })
    writeFileSync(
      join(root, "scripts/ci/csf3-story-files.json"),
      JSON.stringify(listed),
    )
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

test("CSF 4 files and listed CSF 3 files pass", () => {
  const result = check(
    {
      "Card.stories.tsx": csf4(
        "{ beforeEach: ({ msw }) => { msw.use(sessionHandler) } }",
      ),
      "Old.stories.tsx": csf3,
    },
    ["apps/ui/src/Old.stories.tsx"],
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    /Story format check passed \(2 story files, 1 not converted yet\)/,
  )
})

test("a CSF 3 file that the list does not have fails", () => {
  const result = check({ "Old.stories.tsx": csf3 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Old\.stories\.tsx is CSF 3\. Write it in CSF 4/)
})

test("a listed file that is CSF 4 now, or that does not exist, fails", () => {
  const result = check({ "Card.stories.tsx": csf4() }, [
    "apps/ui/src/Card.stories.tsx",
    "apps/ui/src/Gone.stories.tsx",
  ])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Card\.stories\.tsx is CSF 4 now\. Remove it/)
  assert.match(result.stderr, /Gone\.stories\.tsx, which does not exist/)
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
