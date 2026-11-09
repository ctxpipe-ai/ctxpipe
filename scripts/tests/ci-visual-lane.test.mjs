import assert from "node:assert/strict"
import { test } from "node:test"

import { listVisual, visualRecords, visualSkips } from "../checks/visual.mjs"

// Index entries of the Storybook build (buildIndex), with import paths
// relative to apps/ui.
const card = {
  type: "story",
  id: "features-card--plain",
  importPath: "./src/features/card/Card.stories.tsx",
  exportName: "Plain",
  tags: ["dev"],
}
const home = {
  type: "story",
  id: "pages-home--default",
  importPath: "./src/routes/-home.stories.tsx",
  exportName: "Default",
  tags: ["dev", "page"],
}
const canvas = { ...card, id: "features-card--canvas", exportName: "Canvas" }
const docs = { ...card, type: "docs", id: "features-card--docs" }

const cardDesktop =
  "apps/ui/src/features/card/screenshots/Card.Plain.desktop.screenshot.png"
const homeDesktop =
  "apps/ui/src/routes/screenshots/-home.Default.desktop.screenshot.png"
const homeMobile =
  "apps/ui/src/routes/screenshots/-home.Default.mobile.screenshot.png"

test("each story with a screenshot is one visual check that owns its baselines", () => {
  const checks = listVisual(
    [card, home, canvas, docs],
    [
      { id: canvas.id, ticket: "CTX-1" },
      { id: home.id, viewport: "mobile", ticket: "CTX-2" },
    ],
  )
  assert.deepEqual(
    checks.map((check) => [check.id, check.ownInputs]),
    [
      [
        "storybook:visual:apps/ui/src/features/card/Card.stories.tsx#features-card--plain",
        [cardDesktop],
      ],
      // The mobile screenshot is known unstable, so the check does not read
      // that baseline.
      [
        "storybook:visual:apps/ui/src/routes/-home.stories.tsx#pages-home--default",
        [homeDesktop],
      ],
    ],
  )
  const [check] = checks
  assert.equal(check.family, "storybook")
  assert.equal(check.lane, "visual")
  assert.equal(check.root, "apps/ui")
  assert.equal(check.file, "apps/ui/src/features/card/Card.stories.tsx")
  // The key holds the platform of the Docker server, not of the host.
  assert.equal(check.portable, true)
  assert.deepEqual(check.programs, ["container-platform"])
  assert.deepEqual(check.prerequisites, ["storybook-build", "visual-container"])
  // Each check that a change reaches runs; a selector does not sample it.
  assert.equal(check.selectAll, true)
  for (const input of [
    "scripts/ci/visual-container.json",
    "scripts/ci/visual-capture.mjs",
    "scripts/ci/visual-unstable-stories.json",
    "packages/visual-review/src/compare/**",
  ])
    assert.ok(check.inputs.includes(input), input)
  // A page story has a mobile baseline too.
  assert.deepEqual(listVisual([home], [])[0].ownInputs, [
    homeDesktop,
    homeMobile,
  ])
})

// A manifest entry (packages/visual-review/src/compare/manifest.ts).
const entry = (story, viewport, status, more = {}) => ({
  id: story.id,
  componentFile: `apps/ui/${story.importPath.slice(2)}`,
  viewport,
  baseline: viewport === "mobile" ? homeMobile : cardDesktop,
  status,
  summary: null,
  ...more,
})

test("a record passes when each screenshot of the story is unchanged, and else gives the change and the images", () => {
  const records = visualRecords(
    {
      stories: [
        entry(card, "desktop", "changed", {
          summary: "1 region changed: color-change at top-left",
          diffPixels: 120,
        }),
        entry(home, "desktop", "unchanged", { baseline: homeDesktop }),
        entry(home, "mobile", "unchanged"),
      ],
      budget: [],
    },
    300,
  )
  assert.deepEqual(
    records.map(({ id, status }) => [id, status]),
    [
      [
        "storybook:visual:apps/ui/src/features/card/Card.stories.tsx#features-card--plain",
        "failed",
      ],
      [
        "storybook:visual:apps/ui/src/routes/-home.stories.tsx#pages-home--default",
        "passed",
      ],
    ],
  )
  const [failed, passed] = records
  assert.equal(failed.log, ".ci-results/visual/manifest.json")
  assert.match(failed.message, /desktop changed: 120 pixels differ/)
  assert.match(failed.message, /1 region changed: color-change at top-left/)
  assert.match(failed.message, /\.ci-results\/visual\/features-card--plain\//)
  assert.match(
    failed.message,
    /pnpm visual:update --only features-card--plain/,
  )
  assert.deepEqual(
    failed.cases.map(({ name, status }) => [name, status]),
    [["desktop", "failed"]],
  )
  assert.equal(passed.message, undefined)
  assert.deepEqual(
    passed.cases.map(({ name, status }) => [name, status]),
    [
      ["desktop", "passed"],
      ["mobile", "passed"],
    ],
  )
  // The time of the run is shared among the stories.
  assert.deepEqual(
    records.map(({ durationMs }) => durationMs),
    [150, 150],
  )
  // An orphan baseline is no check.
  assert.deepEqual(
    visualRecords(
      { stories: [{ ...entry(card, "desktop", "removed") }], budget: [] },
      0,
    ),
    [],
  )
})

test("a story whose baseline is above the image budget fails", () => {
  const [record] = visualRecords(
    {
      stories: [entry(card, "desktop", "unchanged")],
      budget: [
        {
          path: cardDesktop,
          message: `${cardDesktop} is 1.43 MB; one image may be 1 MB.`,
        },
      ],
    },
    10,
  )
  assert.equal(record.status, "failed")
  assert.match(record.message, /one image may be 1 MB/)
})

test("a story with parameters.visual.skip and a reason has no screenshot", async () => {
  const { csfTools } =
    await import("../../apps/ui/.storybook/check-modules.mjs")
  const { loadCsf } = await csfTools()
  const story = (exportName) => ({
    type: "story",
    id: `features-x--${exportName.toLowerCase()}`,
    importPath: "./src/features/x/X.stories.tsx",
    exportName,
  })
  const text = (skip) => `export default { title: "Features/X" }
export const Plain = {}
export const Canvas = {
  parameters: { intent: "draws", visual: { skip: ${skip} } },
}
`
  assert.deepEqual(
    visualSkips([story("Plain"), story("Canvas")], loadCsf, () =>
      text('"A WebGL canvas draws a new frame at each shot."'),
    ),
    new Map([
      ["features-x--canvas", "A WebGL canvas draws a new frame at each shot."],
    ]),
  )
  // A story inherits an opt-out of its meta (the default export).
  const meta = `export default {
  title: "Features/X",
  parameters: { visual: { skip: "The whole file draws a canvas." } },
}
export const Plain = {}
export const Canvas = { parameters: { visual: { skip: "Its own reason." } } }
`
  assert.deepEqual(
    visualSkips([story("Plain"), story("Canvas")], loadCsf, () => meta),
    new Map([
      ["features-x--plain", "The whole file draws a canvas."],
      ["features-x--canvas", "Its own reason."],
    ]),
  )
  // An opt-out needs its reason.
  for (const skip of ['""', "true"])
    assert.throws(
      () => visualSkips([story("Canvas")], loadCsf, () => text(skip)),
      /apps\/ui\/src\/features\/x\/X\.stories\.tsx Canvas: parameters\.visual\.skip needs a reason/,
    )
})

test("the nightly trace records each story under the id of its screenshot check, also a story without a play", async () => {
  const { traceRecordsOf } = await import("../checks/storybook.mjs")
  const { selectTracedStories } = await import("../ci/storybook-select.mjs")
  const played = { ...card, tags: ["dev", "play-fn"] }
  const record = (id) => ({
    id,
    recorded: ["browser"],
    cases: [{ name: "Plain", durationMs: 5, lines: { "x.ts": [[1, 2]] } }],
  })
  const [shot] = listVisual([card], [])
  // A story without a play function: only its screenshot check.
  assert.deepEqual(
    traceRecordsOf(card, record("storybook:plays:x#y")).map(({ id }) => id),
    [shot.id],
  )
  // A story with a play: the play check, and the screenshot check with the
  // same lines (the screenshot is taken after the play).
  const both = traceRecordsOf(played, record("storybook:plays:x#y"))
  assert.deepEqual(
    both.map(({ id }) => id),
    ["storybook:plays:x#y", shot.id],
  )
  assert.deepEqual(both[1].cases, both[0].cases)
  // The traced run renders every story, sorted by id, and no docs entry.
  assert.deepEqual(
    selectTracedStories({
      entries: { [home.id]: home, [played.id]: played, [docs.id]: docs },
    }).map(({ id }) => id),
    [played.id, home.id],
  )
})
