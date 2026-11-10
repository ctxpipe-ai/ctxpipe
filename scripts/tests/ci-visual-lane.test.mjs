import assert from "node:assert/strict"
import { test } from "node:test"

import {
  listVisual,
  visualOptions,
  visualRecords,
} from "../checks/visual.mjs"

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

test("the options of a story set its viewports and its named snapshots, and skip removes its check", () => {
  const options = new Map([
    [card.id, { viewports: ["desktop", "mobile"], snapshots: ["menu-open"] }],
    [home.id, { viewports: ["desktop"] }],
    [canvas.id, { skip: "A WebGL canvas." }],
  ])
  const checks = listVisual([card, home, canvas], [], options)
  const folder = "apps/ui/src/features/card/screenshots"
  assert.deepEqual(
    checks.map((check) => check.ownInputs),
    [
      [
        cardDesktop,
        `${folder}/Card.Plain@menu-open.desktop.screenshot.png`,
        `${folder}/Card.Plain.mobile.screenshot.png`,
        `${folder}/Card.Plain@menu-open.mobile.screenshot.png`,
      ],
      [homeDesktop],
    ],
  )
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

test("the case of a named snapshot names its viewport and its snapshot", () => {
  const [record] = visualRecords(
    {
      stories: [
        entry(card, "desktop", "unchanged", { snapshot: null }),
        entry(card, "desktop", "changed", {
          snapshot: "menu-open",
          diffPixels: 40,
        }),
      ],
      budget: [],
    },
    10,
  )
  assert.deepEqual(
    record.cases.map(({ name, status }) => [name, status]),
    [
      ["desktop", "passed"],
      ["desktop@menu-open", "failed"],
    ],
  )
  assert.match(record.message, /^desktop@menu-open changed: 40 pixels differ/)
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

const { csfTools } = await import("../../apps/ui/.storybook/check-modules.mjs")
const { loadCsf } = await csfTools()
const storyOf = (exportName) => ({
  type: "story",
  id: `features-x--${exportName.toLowerCase()}`,
  importPath: "./src/features/x/X.stories.tsx",
  exportName,
})
const optionsOf = (text, stories) =>
  visualOptions(stories, loadCsf, () => text)

test("a story with parameters.visual.skip and a reason has no screenshot", () => {
  const text = (reason) => `export default { title: "Features/X" }
export const Plain = {}
export const Canvas = {
  parameters: { intent: "draws", visual: { skip: ${reason} } },
}
`
  assert.deepEqual(
    optionsOf(text('"A WebGL canvas draws a new frame at each shot."'), [
      storyOf("Plain"),
      storyOf("Canvas"),
    ]),
    new Map([
      ["features-x--plain", { snapshots: [] }],
      [
        "features-x--canvas",
        {
          skip: "A WebGL canvas draws a new frame at each shot.",
          snapshots: [],
        },
      ],
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
    optionsOf(meta, [storyOf("Plain"), storyOf("Canvas")]),
    new Map([
      [
        "features-x--plain",
        { skip: "The whole file draws a canvas.", snapshots: [] },
      ],
      ["features-x--canvas", { skip: "Its own reason.", snapshots: [] }],
    ]),
  )
  // An opt-out needs its reason.
  for (const reason of ['""', "true"])
    assert.throws(
      () => optionsOf(text(reason), [storyOf("Canvas")]),
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
    [
      "storybook:plays:apps/ui/src/features/card/Card.stories.tsx#features-card--plain",
      shot.id,
    ],
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

test("the options of a story merge over the options of its meta, and the play gives the named snapshots", () => {
  const text = `import { snapshot } from "@/lib/visual-snapshot"
export default {
  title: "Features/X",
  parameters: { visual: { masks: ["canvas"], maxDiffPixels: 40 } },
}
export const Plain = {}
export const Menu = {
  parameters: {
    visual: { fullPage: true, maxDiffPixels: 0, viewports: ["desktop", "mobile"] },
  },
  play: async ({ canvas }) => {
    await snapshot("menu-open")
    if (canvas) await snapshot("saved")
  },
}
`
  const options = optionsOf(text, [storyOf("Plain"), storyOf("Menu")])
  assert.deepEqual(options.get("features-x--plain"), {
    masks: ["canvas"],
    maxDiffPixels: 40,
    snapshots: [],
  })
  assert.deepEqual(options.get("features-x--menu"), {
    masks: ["canvas"],
    maxDiffPixels: 0,
    fullPage: true,
    viewports: ["desktop", "mobile"],
    snapshots: ["menu-open", "saved"],
  })
})

test("an option that is not valid stops the list and names the story", () => {
  const story = (visual, play = "") => `export default { title: "Features/X" }
export const Menu = { parameters: { visual: ${visual} }${play} }
`
  for (const [visual, message] of [
    ["{ fullPage: 1 }", /fullPage must be true or false/],
    ["{ maxDiffPixels: 1.5 }", /maxDiffPixels must be a whole number/],
    ["{ maxDiffPixels: -1 }", /maxDiffPixels must be a whole number/],
    ['{ viewports: ["tablet"] }', /viewports must be a list/],
    ["{ viewports: [] }", /viewports must be a list/],
    ['{ viewports: ["desktop", "desktop"] }', /viewports must be a list/],
    ["{ masks: [name] }", /masks must be a list of CSS selectors/],
    ["{ mask: [] }", /has no option "mask"/],
    ["shared", /must be an object literal/],
  ])
    assert.throws(
      () => optionsOf(story(visual), [storyOf("Menu")]),
      (error) =>
        /X\.stories\.tsx Menu: parameters\.visual/.test(error.message) &&
        message.test(error.message),
      visual,
    )
  for (const [play, message] of [
    ["snapshot(name)", /needs a name in kebab case/],
    ['snapshot("Menu Open")', /needs a name in kebab case/],
    ['snapshot("a"); await snapshot("a")', /two snapshot\("a"\) calls/],
  ])
    assert.throws(
      () =>
        optionsOf(story("{}", `, play: async () => { await ${play} }`), [
          storyOf("Menu"),
        ]),
      message,
      play,
    )
})
