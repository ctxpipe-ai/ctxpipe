import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(
  new URL("../ci/check-story-play-timing.mjs", import.meta.url),
)

/** Runs the check on one story file with this text. */
function check(text) {
  const dir = mkdtempSync(join(tmpdir(), "ctxpipe-play-timing-"))
  try {
    const file = join(dir, "Card.stories.tsx")
    writeFileSync(file, text)
    return spawnSync(process.execPath, [script, file], { encoding: "utf8" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A story, then a helper that measures. The check reads only the stories,
// so the helper is not part of the story above it.
const storyThenHelper = (open, close) => `
const meta = preview.meta({ title: "Card" })
export const Plain = ${open}
  play: async () => {},
${close}

function widthOf(element) {
  return element.getBoundingClientRect().width
}
`

test("a helper below a CSF 4 story is not part of the story", () => {
  const result = check(storyThenHelper("meta.story({", "})"))
  assert.equal(result.status, 0, result.stderr)
})

test("a helper below a CSF 3 story is not part of the story", () => {
  const result = check(storyThenHelper("{", "}"))
  assert.equal(result.status, 0, result.stderr)
})

test("a CSF 4 story that measures before the fonts fails on its own line", () => {
  const result = check(`
export const Measured = meta.story({
  play: async ({ canvasElement }) => {
    canvasElement.getBoundingClientRect()
    await document.fonts.ready
  },
})
`)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Card\.stories\.tsx:4: layout measure before/)
})
