import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(
  new URL("../ci/check-duplicate-screenshots.mjs", import.meta.url),
)
const { decode, encode } = createRequire(
  new URL("../../packages/visual-review/package.json", import.meta.url),
)("@blazediff/codec-png-native")

/** A PNG of 4 x 4 pixels of one gray level. */
const png = (gray) =>
  encode({
    data: new Uint8Array(4 * 4 * 4).map((_, index) =>
      index % 4 === 3 ? 255 : gray,
    ),
    width: 4,
    height: 4,
  })

/** Runs the check on a fixture repo with these files under apps/ui/src. */
function check(files) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-duplicate-screenshots-"))
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = join(root, "apps/ui/src", name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
    }
    return spawnSync(process.execPath, [script, root], { encoding: "utf8" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const storyFile = (stories) => `
const meta = { title: "Example" }
export default meta
${stories}
`

test("stories with their own pixels pass, and a named snapshot may repeat its story", () => {
  const result = check({
    "x/Card.stories.tsx": storyFile(
      "export const Empty = {}\nexport const Full = {}",
    ),
    "x/screenshots/Card.Empty.desktop.screenshot.png": png(10),
    "x/screenshots/Card.Empty@menu.desktop.screenshot.png": png(10),
    "x/screenshots/Card.Full.desktop.screenshot.png": png(200),
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    /Duplicate screenshot check passed \(3 baselines of 2 stories\)/,
  )
})

test("two stories with the same pixels fail, also in two story files", () => {
  const result = check({
    "x/Card.stories.tsx": storyFile("export const Connected = {}"),
    "x/-card.page.stories.tsx": storyFile("export const Connected = {}"),
    "x/screenshots/Card.Connected.desktop.screenshot.png": png(10),
    "x/screenshots/-card.page.Connected.mobile.screenshot.png": png(10),
  })
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /same pixels:\n {2}apps\/ui\/src\/x\/screenshots\/-card\.page\.Connected\.mobile\.screenshot\.png\n {2}apps\/ui\/src\/x\/screenshots\/Card\.Connected\.desktop\.screenshot\.png\n/,
  )
})

test("a story with a duplicate reason may repeat one story, and the reason must be a string", () => {
  const files = (visual) => ({
    "x/Card.stories.tsx": storyFile(
      `export const Shown = {}\nexport const Hidden = { parameters: { visual: ${visual} } }`,
    ),
    "x/screenshots/Card.Shown.desktop.screenshot.png": png(10),
    "x/screenshots/Card.Hidden.desktop.screenshot.png": png(10),
  })
  const allowed = check(
    files(`{ duplicate: "The hidden card keeps its place on purpose." }`),
  )
  assert.equal(allowed.status, 0, allowed.stderr)
  const noReason = check(files(`{ duplicate: "" }`))
  assert.equal(noReason.status, 1)
  assert.match(noReason.stderr, /parameters\.visual\.duplicate needs a reason/)
})

test("a baseline with no story file is left to the orphan check", () => {
  const result = check({
    "x/Card.stories.tsx": storyFile("export const Empty = {}"),
    "x/screenshots/Card.Empty.desktop.screenshot.png": png(10),
    "x/screenshots/Gone.Empty.desktop.screenshot.png": png(10),
  })
  assert.equal(result.status, 0, result.stderr)
})

test("the same pixels in another PNG encoding are a duplicate, and the same color at another size is not", () => {
  const recompressed = encode(decode(png(10)), {
    compression: 1,
    filter: "paeth",
  })
  assert.notDeepEqual(Buffer.from(recompressed), Buffer.from(png(10)))
  const same = check({
    "x/Card.stories.tsx": storyFile("export const A = {}\nexport const B = {}"),
    "x/screenshots/Card.A.desktop.screenshot.png": png(10),
    "x/screenshots/Card.B.desktop.screenshot.png": recompressed,
  })
  assert.equal(same.status, 1)
  const wide = encode({
    data: new Uint8Array(8 * 2 * 4).map((_, index) =>
      index % 4 === 3 ? 255 : 10,
    ),
    width: 8,
    height: 2,
  })
  const otherSize = check({
    "x/Card.stories.tsx": storyFile("export const A = {}\nexport const B = {}"),
    "x/screenshots/Card.A.desktop.screenshot.png": png(10),
    "x/screenshots/Card.B.desktop.screenshot.png": wide,
  })
  assert.equal(otherSize.status, 0, otherSize.stderr)
})
